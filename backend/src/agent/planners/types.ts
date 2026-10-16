import type { AgentContext } from "../agentState";
import type { ToolResult } from "../tools/types";

export interface PlannedCall {
    id: string;
    name: string;
    args: unknown;
}

export type PlannerDecision =
    { type: "tool_calls"; calls: PlannedCall[]; text?: string } | { type: "finish"; text: string };

export interface ToolOutcome {
    call: PlannedCall;
    result: ToolResult;
}

/** Decides the next tool call(s). Planners only propose; the tool registry decides what may run. */
export interface Planner {
    readonly kind: "llm" | "deterministic";
    next(ctx: AgentContext, lastOutcomes: ToolOutcome[]): Promise<PlannerDecision>;
}
