import { z } from "zod";
import { env } from "../config/env";
import { recordAudit } from "../services/auditService";
import { ApiError, errorMessage } from "../utils/errors";
import { scrubSecrets } from "../utils/logger";
import { TimeoutError, withTimeout } from "../utils/timeout";
import { ALLOWED_TOOLS, type AgentContext, type ToolName } from "./agentState";
import { traceToolResult } from "./agentTrace";
import { allTools } from "./tools";
import type { ToolDefinition, ToolError, ToolResult } from "./tools/types";

export type { ToolDefinition, ToolError, ToolResult } from "./tools/types";

const registry = new Map<ToolName, ToolDefinition<unknown>>(
    allTools.map((t) => [t.name, t as ToolDefinition<unknown>]),
);

export const getTool = (name: string): ToolDefinition<unknown> | undefined => registry.get(name as ToolName);

/** JSON Schema tool definitions for the LLM planner (only planner-visible tools). */
export interface PlannerToolSpec {
    name: ToolName;
    description: string;
    /** JSON Schema generated from the same Zod schema executeTool validates against. */
    parameters: Record<string, unknown>;
}

/** Provider-neutral descriptions of the tools a planner may call (planner-visible tools only). */
export const plannerToolSpecs = (): PlannerToolSpec[] =>
    [...registry.values()]
        .filter((t) => t.plannerVisible)
        .map((t) => {
            const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
            return { name: t.name, description: t.description, parameters: { type: "object", ...schema } };
        });

/** Anthropic tool definitions (legacy planner). */
export const plannerToolDefinitions = () =>
    plannerToolSpecs().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { ...t.parameters, type: "object" as const },
    }));

const fail = (code: string, message: string, retryable = false, details?: unknown): ToolResult => ({
    ok: false,
    error: { code, message, retryable, details },
});

const toToolError = (error: unknown): ToolError => {
    if (error instanceof TimeoutError) return { code: "TIMEOUT", message: error.message, retryable: true };
    if (error instanceof ApiError) {
        const hint = (error.errors[0] as { retryable?: boolean } | undefined)?.retryable;
        const retryable =
            hint ??
            (error.code === "INTERNAL_ERROR" || (error.code === "PROCESSING_ERROR" && /timed out/.test(error.message)));
        return { code: error.code, message: error.message, retryable };
    }
    return { code: "INTERNAL_ERROR", message: errorMessage(error), retryable: true };
};

const truncate = (value: unknown, max = 4000): unknown => {
    const json = JSON.stringify(value);
    return json && json.length > max ? { truncated: true, preview: json.slice(0, max) } : value;
};

/**
 * The only path by which the agent executes a tool. Enforces, in order: known tool, planner visibility,
 * state permission, the escalation gate, argument schema, retry limit and timeout. Every call is logged.
 */
export const executeTool = async (ctx: AgentContext, name: string, rawArgs: unknown): Promise<ToolResult> => {
    const started = Date.now();
    const tool = getTool(name);
    let result: ToolResult;
    let args: unknown = rawArgs;

    if (!tool) {
        result = fail("UNKNOWN_TOOL", `Unknown tool "${name}"`);
    } else if (!tool.plannerVisible) {
        result = fail("NOT_PERMITTED", `${name} requires an authorized user and cannot be called by the agent`);
    } else if (!ALLOWED_TOOLS[ctx.state].includes(tool.name)) {
        result = fail(
            "TOOL_NOT_PERMITTED",
            `${name} is not allowed in state ${ctx.state}. Allowed: ${ALLOWED_TOOLS[ctx.state].join(", ") || "none"}`,
        );
    } else if (ctx.pendingEscalation.length > 0 && tool.name !== "notify_human") {
        result = fail(
            "ESCALATION_REQUIRED",
            `Blocking evidence issues must be handed to a human first (notify_human): ${ctx.pendingEscalation.map((r) => r.code).join(", ")}`,
        );
    } else {
        const parsed = tool.schema.safeParse(rawArgs ?? {});
        if (!parsed.success) {
            result = fail(
                "INVALID_ARGUMENTS",
                `Invalid arguments for ${name}`,
                false,
                parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            );
        } else {
            args = parsed.data;
            const key = `${tool.name}:${tool.attemptKey?.(parsed.data) ?? ""}`;
            const attempt = (ctx.attempts[key] ?? 0) + 1;
            if (attempt > env.AGENT_MAX_TOOL_RETRIES + 1) {
                result = fail("RETRY_LIMIT", `${name} already failed ${attempt - 1} time(s); escalate to a human`);
            } else {
                ctx.attempts[key] = attempt;
                // A tool never runs past its own timeout or the remaining inspection budget, whichever is sooner.
                ctx.toolDeadline = Math.min(ctx.deadline, Date.now() + env.AGENT_TOOL_TIMEOUT_MS);
                const remainingMs = ctx.toolDeadline - Date.now();
                try {
                    if (remainingMs <= 0) {
                        result = fail("TIMEOUT", `Inspection time budget exhausted before ${name} could run`);
                    } else {
                        const data = await withTimeout(tool.handler(parsed.data, ctx), remainingMs, name);
                        result = { ok: true, data };
                    }
                } catch (error) {
                    result = { ok: false, error: toToolError(error) };
                } finally {
                    ctx.toolDeadline = undefined;
                }
            }
        }
    }

    const durationMs = Date.now() - started;
    traceToolResult(name, args, result, durationMs, ctx.plannerName);
    ctx.inspection.agentLog.push({
        kind: "tool_call",
        planner: ctx.plannerName,
        attempt: ctx.inspection.attempt,
        iteration: ctx.iteration,
        state: ctx.state,
        tool: name,
        args: scrubSecrets(args),
        result: result.ok ? truncate(result.data) : undefined,
        error: result.ok ? undefined : `${result.error.code}: ${result.error.message}`,
        durationMs,
    });
    await ctx.inspection.save();
    await recordAudit({
        action: `agent.tool.${name}`,
        actorType: "agent",
        actorId: ctx.principal.userId,
        shopId: ctx.inspection.shopId,
        orderId: ctx.inspection.orderId,
        inspectionId: ctx.inspection.id,
        outcome: result.ok ? "success" : "failure",
        details: { durationMs, ...(result.ok ? {} : { error: result.error.code }) },
    });
    return result;
};
