import { env } from "../config/env";
import { Claim } from "../models/Claim";
import { Inspection, type InspectionDoc, type InspectionStatus } from "../models/Inspection";
import { Order } from "../models/Order";
import { User } from "../models/User";
import { recordAudit } from "../services/auditService";
import type { EscalationReason } from "../services/evidenceValidationService";
import { createReviewTask } from "../services/reviewService";
import { storage } from "../services/storageService";
import type { AuthPrincipal } from "../types/auth";
import { errorMessage } from "../utils/errors";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/timeout";
import { createContext, knownEscalations, transition, type AgentContext } from "./agentState";
import { DeterministicPlanner } from "./planners/deterministicPlanner";
import { GeminiPlanner } from "./planners/geminiPlanner";
import { LlmPlanner } from "./planners/llmPlanner";
import type { Planner, ToolOutcome } from "./planners/types";
import { executeTool } from "./toolRegistry";

/** The LLM planner for the active provider, or the fixed workflow when the inspection was created for it. */
const createPlanner = (inspection: InspectionDoc): Planner => {
    if (inspection.planner !== "llm") return new DeterministicPlanner();
    return env.activeProvider === "anthropic" ? new LlmPlanner() : new GeminiPlanner();
};

/** One-glance provenance: demo data, real AI end to end, or a real run that fell back to the fixed workflow. */
const executionLabelFor = (inspection: InspectionDoc) => {
    if (inspection.analysisMode === "demo") return "DEMO" as const;
    if (inspection.plannerFallback) return "DETERMINISTIC_FALLBACK" as const;
    return env.activeProvider === "anthropic" ? ("REAL_ANTHROPIC" as const) : ("REAL_GEMINI" as const);
};

export interface RunOptions {
    /** Test hook: inject a planner. */
    planner?: Planner;
}

const log = (ctx: AgentContext, kind: "planner" | "guardrail" | "error" | "note", message: string, extra = {}) => {
    ctx.inspection.agentLog.push({
        kind,
        message,
        attempt: ctx.inspection.attempt,
        iteration: ctx.iteration,
        state: ctx.state,
        ...extra,
    });
};

const principalFor = async (inspection: InspectionDoc): Promise<AuthPrincipal> => {
    const user = await User.findById(inspection.requestedBy);
    if (!user || !user.active)
        throw new Error("The user who requested this inspection no longer exists or is inactive");
    return {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        shopId: user.shopId,
        warehouseIds: user.warehouseIds,
    };
};

/**
 * Run (or re-run) the FixIt agent for one inspection.
 * The planner proposes tool calls; the tool registry enforces the workflow; deterministic guardrails and a
 * database read-back decide the final status. The LLM's own words never determine success.
 */
export const runInspection = async (inspectionId: string, options: RunOptions = {}): Promise<InspectionDoc> => {
    const inspection = await Inspection.findById(inspectionId);
    if (!inspection) throw new Error(`Inspection ${inspectionId} not found`);
    if (inspection.status !== "pending") return inspection;

    const markOrder = (status: InspectionStatus) =>
        Order.updateOne(
            { _id: inspection.orderRef },
            { $set: { inspectionStatus: status, latestInspectionId: inspection._id } },
        );

    let ctx: AgentContext | undefined;
    try {
        const principal = await principalFor(inspection);
        ctx = createContext(inspection, principal);
        inspection.set({ status: "processing", startedAt: new Date(), finishedAt: undefined, error: undefined });
        let planner: Planner = options.planner ?? createPlanner(inspection);
        ctx.plannerName = planner.name;
        log(
            ctx,
            "note",
            `Attempt ${inspection.attempt} started. Analysis mode: ${inspection.analysisMode}. planner=${planner.name}.`,
            { planner: planner.name, fallbackUsed: false },
        );
        inspection.stateHistory.push({
            state: "RECEIVED",
            at: new Date(),
            note: "Inspection started",
            attempt: inspection.attempt,
        });
        inspection.workflowState = "RECEIVED";
        await inspection.save();
        await markOrder("processing");

        const narrative = await runLoop(ctx, planner, (next) => (planner = next));
        await applyGuardrails(ctx);
        return await finalize(ctx, narrative);
    } catch (error) {
        logger.error("Inspection failed", { inspectionId, error: errorMessage(error) });
        const failed = (await Inspection.findById(inspectionId))!;
        failed.set({ status: "failed", workflowState: "FAILED", error: errorMessage(error), finishedAt: new Date() });
        failed.stateHistory.push({
            state: "FAILED",
            at: new Date(),
            note: errorMessage(error),
            attempt: failed.attempt,
        });
        failed.agentLog.push({ kind: "error", message: errorMessage(error), attempt: failed.attempt });
        failed.recommendedAction = "Retry the inspection. If it fails again, review the evidence manually.";
        await failed.save();
        await markOrder("failed");
        await recordAudit({
            action: "inspection.failed",
            actorType: "system",
            shopId: failed.shopId,
            orderId: failed.orderId,
            inspectionId: failed.id,
            outcome: "failure",
            details: { error: errorMessage(error) },
        });
        return failed;
    }
};

const runLoop = async (
    ctx: AgentContext,
    initial: Planner,
    swap: (p: Planner) => void,
): Promise<string | undefined> => {
    let planner = initial;
    let last: ToolOutcome[] = [];

    for (ctx.iteration = 1; ctx.iteration <= env.AGENT_MAX_ITERATIONS; ctx.iteration++) {
        const remainingMs = ctx.deadline - Date.now();
        if (remainingMs <= 0) {
            log(ctx, "guardrail", `Agent time limit of ${env.AGENT_TIMEOUT_MS} ms reached; stopping`);
            await ctx.inspection.save();
            return undefined;
        }
        let decision;
        try {
            // The planner shares the inspection budget; it cannot outlive the deadline.
            decision = await withTimeout(planner.next(ctx, last), remainingMs, "planner");
        } catch (error) {
            const failedName = planner.name;
            log(ctx, "error", `planner=${failedName} failed: ${errorMessage(error)}`, {
                planner: failedName,
                reason: errorMessage(error),
            });
            if (planner.kind === "llm") {
                // Fall back to the fixed workflow; tools still enforce every rule. Every later decision is
                // labelled planner=deterministic so it is never mistaken for an LLM decision.
                planner = new DeterministicPlanner();
                swap(planner);
                ctx.plannerName = planner.name;
                ctx.inspection.plannerFallback = true;
                log(ctx, "guardrail", `Switched to the deterministic planner after a ${failedName} planner failure`, {
                    planner: planner.name,
                    fallbackUsed: true,
                    reason: errorMessage(error),
                });
                await ctx.inspection.save();
                last = [];
                continue;
            }
            throw error;
        }

        const fallbackUsed = Boolean(ctx.inspection.plannerFallback);
        if (decision.type === "finish") {
            log(ctx, "planner", `planner=${planner.name} finished`, {
                planner: planner.name,
                fallbackUsed,
                rationale: decision.text.slice(0, 2000) || undefined,
            });
            await ctx.inspection.save();
            return decision.text || undefined;
        }
        const selectedTools = decision.calls.map((c) => c.name);
        log(ctx, "planner", `planner=${planner.name} selected ${selectedTools.join(", ")}`, {
            planner: planner.name,
            selectedTools,
            fallbackUsed,
            rationale: decision.text ? decision.text.slice(0, 1000) : undefined,
        });
        last = [];
        for (const call of decision.calls) {
            last.push({ call, result: await executeTool(ctx, call.name, call.args) });
        }
    }
    log(ctx, "guardrail", `Iteration limit of ${env.AGENT_MAX_ITERATIONS} reached; stopping`);
    await ctx.inspection.save();
    return undefined;
};

const escalate = async (ctx: AgentContext, reasons: EscalationReason[], note: string) => {
    log(ctx, "guardrail", note, { reason: reasons.map((r) => `${r.code}: ${r.message}`).join("; ") });
    await createReviewTask({
        inspection: ctx.inspection,
        principal: ctx.principal,
        reasons,
        agentNote: note,
        findings: ctx.comparison?.findings,
        actorType: "system",
    });
    ctx.reviewTaskCreated = true;
    ctx.pendingEscalation = [];
    await transition(ctx, "HUMAN_REVIEW", "Escalated by backend guardrail");
};

/** Deterministic policy enforcement after the planner stops, whatever the planner decided. */
const applyGuardrails = async (ctx: AgentContext) => {
    const known = knownEscalations(ctx);
    const blocking = known.filter((r) => r.blocking);

    if (blocking.length && !ctx.reviewTaskCreated) {
        await escalate(ctx, blocking, "Blocking evidence issues were not handed to a human by the planner");
        return;
    }
    if (ctx.reviewTaskCreated && blocking.length) return;

    const complete = Boolean(ctx.comparison && ctx.finalValidation);
    if (!complete) {
        if (!ctx.reviewTaskCreated) {
            await escalate(
                ctx,
                [
                    {
                        code: "WORKFLOW_ERROR",
                        blocking: true,
                        message: `The inspection stopped before completing (last state ${ctx.state})`,
                    },
                ],
                "Workflow incomplete",
            );
        }
        return;
    }

    if ((ctx.comparison?.materialDiscrepancyCount ?? 0) > 0 && !ctx.claimId && ctx.state === "VERIFICATION") {
        log(ctx, "guardrail", "Material discrepancies found but no claim drafted; drafting it now");
        const result = await executeTool(ctx, "build_claim_pack", {});
        if (!result.ok) {
            await escalate(
                ctx,
                [
                    {
                        code: "WORKFLOW_ERROR",
                        blocking: true,
                        message: `Claim draft could not be generated: ${result.error.message}`,
                    },
                ],
                "Claim generation failed",
            );
            return;
        }
    }

    const advisory = known.filter((r) => !r.blocking);
    if (advisory.length && !ctx.reviewTaskCreated) {
        await escalate(ctx, advisory, "Advisory escalation rules apply (for example a high-value order)");
    }
};

/** Decide the final status from persisted records, not from in-memory or planner state. */
const finalize = async (ctx: AgentContext, narrative: string | undefined): Promise<InspectionDoc> => {
    await ctx.inspection.save();
    const fresh = (await Inspection.findById(ctx.inspection._id))!;

    let claimOk = false;
    if (fresh.claimId) {
        const claim = await Claim.findById(fresh.claimId);
        claimOk = Boolean(claim?.reportStorageKey && (await storage().exists(claim.reportStorageKey)));
        if (!claimOk) {
            ctx.inspection = fresh;
            await escalate(
                ctx,
                [{ code: "WORKFLOW_ERROR", blocking: true, message: "Claim record or report is missing" }],
                "Claim verification failed",
            );
        }
    }

    const current = (await Inspection.findById(ctx.inspection._id))!;
    const finalValidation = current.evidenceValidation?.final;
    const comparison = current.comparison;
    let status: InspectionStatus;
    if (current.reviewTask?.status === "open") status = "needs_review";
    else if (comparison && finalValidation?.ok) status = "completed";
    else status = "failed";

    current.set({
        status,
        workflowState: status === "needs_review" ? "HUMAN_REVIEW" : status === "completed" ? "COMPLETED" : "FAILED",
        summary: buildSummary(current, claimOk),
        recommendedAction: recommendAction(current, status, claimOk),
        agentNarrative: narrative?.slice(0, 4000),
        plannerUsed: ctx.plannerName,
        executionLabel: executionLabelFor(current),
        finishedAt: new Date(),
    });
    if (status === "needs_review") {
        // The single place an auditor can read why a human was brought in, whoever triggered it.
        current.agentLog.push({
            kind: "note",
            message: "HUMAN_REVIEW",
            attempt: current.attempt,
            planner: ctx.plannerName,
            fallbackUsed: Boolean(current.plannerFallback),
            reason: (current.reviewTask?.reasons ?? []).join("; ") || current.reviewTask?.reason,
        });
    }
    if (status === "completed") {
        current.stateHistory.push({
            state: "COMPLETED",
            at: new Date(),
            note: "Inspection completed",
            attempt: current.attempt,
        });
    }
    await current.save();
    await Order.updateOne(
        { _id: current.orderRef },
        {
            $set: {
                inspectionStatus: status,
                latestInspectionId: current._id,
                ...(current.claimId ? { latestClaimId: current.claimId } : {}),
            },
        },
    );
    await recordAudit({
        action: "inspection.finished",
        actorType: "agent",
        actorId: ctx.principal.userId,
        shopId: current.shopId,
        orderId: current.orderId,
        inspectionId: current.id,
        details: { status, claimId: current.claimId?.toString(), escalation: current.escalation?.reasons },
    });
    return current;
};

const buildSummary = (inspection: InspectionDoc, claimOk: boolean): string => {
    const parts: string[] = [];
    if (inspection.analysisMode === "demo") parts.push("[DEMO MODE - predefined results, not real AI analysis]");
    const comparison = inspection.comparison as { summary?: string } | undefined;
    if (comparison?.summary) parts.push(comparison.summary);
    else parts.push("No comparison was completed.");
    const reasons = inspection.reviewTask?.status === "open" ? (inspection.reviewTask.reasons ?? []) : [];
    if (reasons.length) parts.push(`Human review required: ${reasons.join("; ")}`);
    if (claimOk) parts.push("A draft claim report was generated and is pending human approval.");
    parts.push("Findings are visual discrepancies, not proof of wrongdoing.");
    return parts.join(" ");
};

const recommendAction = (inspection: InspectionDoc, status: InspectionStatus, claimOk: boolean): string => {
    if (status === "failed") return "Retry the inspection. If it fails again, review the evidence manually.";
    if (status === "needs_review") {
        if (inspection.escalation?.blocking) return inspection.reviewTask?.requiredAction ?? "Review the evidence.";
        return claimOk
            ? "Review the draft claim and evidence (escalation rule applied) and approve or reject it with a reason."
            : (inspection.reviewTask?.requiredAction ?? "Review the inspection result.");
    }
    if (claimOk) return "Review the draft claim report and approve or reject it with a recorded reason.";
    const findings = ((inspection.comparison as { findings?: Array<{ severity: string }> })?.findings ?? []).filter(
        (f) => f.severity === "low",
    );
    return findings.length
        ? "No claim recommended. Note the minor observations and process the return normally."
        : "No discrepancy observed. Process the return normally.";
};
