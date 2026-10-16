import { env } from "../../config/env";
import { knownEscalations, type AgentContext } from "../agentState";
import type { Planner, PlannerDecision, PlannedCall, ToolOutcome } from "./types";

/**
 * Fixed inspection workflow. Used in demo mode, when AGENT_PLANNER=deterministic,
 * and as the fallback when the LLM planner fails.
 */
export class DeterministicPlanner implements Planner {
    readonly kind = "deterministic" as const;
    private counter = 0;

    private call(name: string, args: Record<string, unknown> = {}): PlannerDecision {
        this.counter++;
        return { type: "tool_calls", calls: [{ id: `det-${this.counter}`, name, args }] };
    }

    async next(ctx: AgentContext, last: ToolOutcome[]): Promise<PlannerDecision> {
        const failed = last.find((o) => !o.result.ok);
        if (failed && !failed.result.ok) {
            const attemptsUsed = Object.entries(ctx.attempts)
                .filter(([key]) => key.startsWith(`${failed.call.name}:`))
                .reduce((max, [, n]) => Math.max(max, n), 0);
            if (failed.result.error.retryable && attemptsUsed <= env.AGENT_MAX_TOOL_RETRIES) {
                return this.retry(failed.call);
            }
            if (!ctx.reviewTaskCreated && ctx.state !== "HUMAN_REVIEW") {
                return this.call("notify_human", {
                    reason: `${failed.call.name} failed: ${failed.result.error.message}`.slice(0, 500),
                });
            }
            return { type: "finish", text: "Stopped after a tool failure." };
        }

        if (ctx.pendingEscalation.length > 0) {
            return this.call("notify_human", {
                reason: `Blocking evidence issues: ${ctx.pendingEscalation.map((r) => r.code).join(", ")}`,
            });
        }

        switch (ctx.state) {
            case "RECEIVED":
                return this.call("lookup_order", { orderId: ctx.inspection.orderId });
            case "ORDER_LOOKUP":
                return this.call("validate_evidence");
            case "EVIDENCE_VALIDATION":
                return this.call("extract_frames", { evidenceType: "outbound" });
            case "FRAME_EXTRACTION":
                if (!ctx.extraction.outbound) return this.call("extract_frames", { evidenceType: "outbound" });
                if (!ctx.extraction.return) return this.call("extract_frames", { evidenceType: "return" });
                if (!ctx.analyses.outbound) return this.call("analyze_item", { evidenceType: "outbound" });
                return this.call("analyze_item", { evidenceType: "return" });
            case "ITEM_ANALYSIS":
                if (!ctx.analyses.return) return this.call("analyze_item", { evidenceType: "return" });
                return this.call("compare_items");
            case "COMPARISON":
                return this.call("validate_evidence");
            case "VERIFICATION":
                if ((ctx.comparison?.materialDiscrepancyCount ?? 0) > 0) return this.call("build_claim_pack");
                return this.advisoryOrFinish(ctx);
            case "CLAIM_DRAFT":
                return this.advisoryOrFinish(ctx);
            default:
                return { type: "finish", text: "Workflow finished." };
        }
    }

    private retry(call: PlannedCall): PlannerDecision {
        this.counter++;
        return { type: "tool_calls", calls: [{ ...call, id: `det-${this.counter}` }] };
    }

    private advisoryOrFinish(ctx: AgentContext): PlannerDecision {
        const advisory = knownEscalations(ctx).filter((r) => !r.blocking);
        if (advisory.length && !ctx.reviewTaskCreated) {
            return this.call("notify_human", {
                reason: advisory
                    .map((r) => r.message)
                    .join("; ")
                    .slice(0, 500),
            });
        }
        return { type: "finish", text: "Workflow finished." };
    }
}
