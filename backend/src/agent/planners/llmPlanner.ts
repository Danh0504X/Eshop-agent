import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { ApiError } from "../../utils/errors";
import { ALLOWED_TOOLS, type AgentContext } from "../agentState";
import { AGENT_SYSTEM_PROMPT } from "../prompts";
import { plannerToolDefinitions } from "../toolRegistry";
import type { Planner, PlannerDecision, ToolOutcome } from "./types";

/** The subset of the SDK client the planner uses, so tests can inject scripted responses. */
export type PlannerClient = { beta: { messages: Pick<Anthropic["beta"]["messages"], "create"> } };

const MAX_RESULT_CHARS = 12_000;

/**
 * Claude-driven planner using a manual tool-use loop. The message history is append-only
 * (assistant content is replayed unchanged, including thinking blocks).
 */
export class LlmPlanner implements Planner {
    readonly kind = "llm" as const;
    readonly name = "anthropic" as const;
    private readonly client: PlannerClient;
    private readonly messages: Anthropic.Beta.BetaMessageParam[] = [];

    constructor(client?: PlannerClient) {
        this.client =
            client ??
            new Anthropic({ apiKey: env.AI_API_KEY, timeout: env.AI_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    }

    async next(ctx: AgentContext, last: ToolOutcome[]): Promise<PlannerDecision> {
        if (this.messages.length === 0) {
            this.messages.push({
                role: "user",
                content: `${ctx.inspection.task}\n\nInspection ID: ${ctx.inspection.id}. Current workflow state: ${ctx.state}.`,
            });
        } else {
            const content: Anthropic.Beta.BetaContentBlockParam[] = last.map((o) => {
                const payload = JSON.stringify(o.result.ok ? o.result.data : { error: o.result.error });
                return {
                    type: "tool_result" as const,
                    tool_use_id: o.call.id,
                    is_error: !o.result.ok,
                    content:
                        payload.length > MAX_RESULT_CHARS
                            ? `${payload.slice(0, MAX_RESULT_CHARS)}...[truncated]`
                            : payload,
                };
            });
            content.push({
                type: "text",
                text: `Workflow state is now ${ctx.state}. Allowed tools: ${ALLOWED_TOOLS[ctx.state].join(", ") || "none - finish with your summary"}.`,
            });
            this.messages.push({ role: "user", content });
        }

        let response: Anthropic.Beta.BetaMessage;
        try {
            response = await this.client.beta.messages.create(
                {
                    model: env.AI_MODEL,
                    max_tokens: 16000,
                    system: AGENT_SYSTEM_PROMPT,
                    thinking: { type: "adaptive" },
                    output_config: { effort: env.AI_EFFORT },
                    tools: plannerToolDefinitions() as Anthropic.Beta.BetaTool[],
                    messages: this.messages,
                    ...(env.AI_REFUSAL_FALLBACK
                        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
                        : {}),
                },
                { timeout: env.AI_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES },
            );
        } catch (error) {
            if (error instanceof Anthropic.APIConnectionTimeoutError)
                throw new ApiError("AI_ERROR", "Planner request timed out");
            if (error instanceof Anthropic.APIError)
                throw new ApiError("AI_ERROR", `Planner request failed (${error.status ?? "network"})`);
            throw error;
        }

        if (response.stop_reason === "refusal") throw new ApiError("AI_ERROR", "Planner model declined the request");
        if (response.stop_reason === "max_tokens") throw new ApiError("AI_ERROR", "Planner response was truncated");
        if (!Array.isArray(response.content)) throw new ApiError("AI_ERROR", "Planner returned a malformed response");

        this.messages.push({ role: "assistant", content: response.content });
        const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        const text = response.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();

        if (toolUses.length === 0) return { type: "finish", text };
        return { type: "tool_calls", text, calls: toolUses.map((b) => ({ id: b.id, name: b.name, args: b.input })) };
    }
}
