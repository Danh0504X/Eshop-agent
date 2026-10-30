import type { AnalysisRecord, SegmentInspectionRecord } from "./schemas";
import { env } from "../config/env";
import type { InspectionDoc, WorkflowState } from "../models/Inspection";
import type { MediaDoc, MediaType } from "../models/MediaEvidence";
import type { OrderDoc } from "../models/Order";
import type { ComparisonResult } from "../services/comparisonService";
import type { EscalationReason, EvidenceValidation } from "../services/evidenceValidationService";
import type { ExtractionResult } from "../services/videoProcessingService";
import type { AuthPrincipal } from "../types/auth";
import { ApiError } from "../utils/errors";

export const TOOL_NAMES = [
    "lookup_order",
    "link_media",
    "extract_frames",
    "validate_evidence",
    "analyze_item",
    "compare_items",
    "build_claim_pack",
    "inspect_video_segment",
    "notify_human",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Tools the agent may call in each workflow state. The backend rejects anything else,
 * so the planner (LLM or deterministic) cannot skip verification steps.
 */
export const ALLOWED_TOOLS: Record<WorkflowState, ToolName[]> = {
    RECEIVED: ["lookup_order"],
    ORDER_LOOKUP: ["validate_evidence", "link_media", "notify_human"],
    EVIDENCE_VALIDATION: ["extract_frames", "notify_human"],
    FRAME_EXTRACTION: ["extract_frames", "analyze_item", "notify_human"],
    ITEM_ANALYSIS: ["analyze_item", "compare_items", "inspect_video_segment", "notify_human"],
    COMPARISON: ["validate_evidence", "inspect_video_segment", "notify_human"],
    VERIFICATION: ["build_claim_pack", "inspect_video_segment", "notify_human"],
    // Entered after a targeted segment inspection. New evidence must be compared and verified again before
    // any claim: there is no path from here to build_claim_pack except compare_items -> validate_evidence.
    ADDITIONAL_INSPECTION: ["inspect_video_segment", "analyze_item", "compare_items", "notify_human"],
    CLAIM_DRAFT: ["notify_human"],
    HUMAN_REVIEW: [],
    COMPLETED: [],
    FAILED: [],
};

export const TERMINAL_STATES: WorkflowState[] = ["HUMAN_REVIEW", "COMPLETED", "FAILED"];

/** Mutable state for one agent run. Everything important is also persisted on the Inspection document. */
export interface AgentContext {
    inspection: InspectionDoc;
    principal: AuthPrincipal;
    state: WorkflowState;
    order?: OrderDoc;
    media: Partial<Record<MediaType, MediaDoc>>;
    extraction: Partial<Record<MediaType, ExtractionResult>>;
    analyses: Partial<Record<MediaType, AnalysisRecord>>;
    /** Analyses started ahead of their analyze_item call, so both videos are analysed at the same time. */
    pendingAnalyses: Partial<Record<MediaType, Promise<AnalysisRecord>>>;
    comparison?: ComparisonResult;
    initialValidation?: EvidenceValidation;
    finalValidation?: EvidenceValidation;
    /** Blocking reasons discovered but not yet handed to a human. While non-empty, only notify_human is allowed. */
    pendingEscalation: EscalationReason[];
    claimId?: string;
    reviewTaskCreated: boolean;
    attempts: Record<string, number>;
    iteration: number;
    /** Epoch ms the whole inspection must finish by (AGENT_TIMEOUT_MS from the start of the run). */
    deadline: number;
    /** Epoch ms the currently running tool must finish by: min(deadline, tool start + AGENT_TOOL_TIMEOUT_MS). */
    toolDeadline?: number;
    /** Targeted segment inspections made in this run (adaptive re-inspection). */
    segmentInspections: SegmentInspectionRecord[];
    budget: BudgetUsage;
    /** Planner currently proposing actions; recorded on every tool log entry. */
    plannerName?: "gemini" | "anthropic" | "deterministic";
}

export const createContext = (inspection: InspectionDoc, principal: AuthPrincipal): AgentContext => ({
    inspection,
    principal,
    state: "RECEIVED",
    media: {},
    extraction: {},
    analyses: {},
    pendingAnalyses: {},
    pendingEscalation: [],
    reviewTaskCreated: false,
    attempts: {},
    iteration: 0,
    deadline: Date.now() + env.AGENT_TIMEOUT_MS,
    segmentInspections: [],
    budget: { aiRequests: 0, segmentInspections: 0, framesAnalyzed: 0, reanalyses: { outbound: 0, return: 0 } },
});

/** All escalation reasons known so far, de-duplicated by code + evidence type. */
export const knownEscalations = (ctx: AgentContext): EscalationReason[] => {
    const all = [
        ...(ctx.initialValidation?.escalationReasons ?? []),
        ...(ctx.finalValidation?.escalationReasons ?? []),
        ...ctx.pendingEscalation,
    ];
    const seen = new Set<string>();
    return all.filter((r) => {
        const key = `${r.code}:${r.evidenceType ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

/** Persist a workflow state transition on the inspection (state, history and log). */
export const transition = async (ctx: AgentContext, next: WorkflowState, note?: string): Promise<void> => {
    if (ctx.state === next) return;
    ctx.state = next;
    ctx.inspection.workflowState = next;
    ctx.inspection.stateHistory.push({ state: next, at: new Date(), note, attempt: ctx.inspection.attempt });
    ctx.inspection.agentLog.push({
        kind: "state",
        state: next,
        message: note,
        attempt: ctx.inspection.attempt,
        iteration: ctx.iteration,
    });
    await ctx.inspection.save();
};

// --- Inspection budgets --------------------------------------------------------------------------------------------

/**
 * Consumption of the per-inspection budgets. These count deliberate work (AI requests, extra segments,
 * re-analyses, frames sent to the model); they are separate from transport retries and tool-failure retries.
 */
export interface BudgetUsage {
    aiRequests: number;
    segmentInspections: number;
    framesAnalyzed: number;
    reanalyses: Record<MediaType, number>;
}

export const budgetRemaining = (ctx: AgentContext) => ({
    aiRequests: Math.max(0, env.MAX_AI_REQUESTS_PER_INSPECTION - ctx.budget.aiRequests),
    segmentInspections: Math.max(0, env.MAX_SEGMENT_INSPECTIONS - ctx.budget.segmentInspections),
    framesAnalyzed: Math.max(0, env.MAX_TOTAL_FRAMES_ANALYZED - ctx.budget.framesAnalyzed),
    reanalyses: {
        outbound: Math.max(0, env.MAX_REANALYSES_PER_VIDEO - ctx.budget.reanalyses.outbound),
        return: Math.max(0, env.MAX_REANALYSES_PER_VIDEO - ctx.budget.reanalyses.return),
    },
});

const exhausted = (what: string) =>
    new ApiError(
        "BUDGET_EXHAUSTED",
        `${what} budget for this inspection is used up; hand over to a human if evidence is still insufficient`,
        [{ retryable: false }],
    );

/** Throws BUDGET_EXHAUSTED unless the requested work fits the remaining budgets. Nothing is consumed. */
export const assertBudget = (
    ctx: AgentContext,
    need: { aiRequests?: number; segmentInspections?: number; frames?: number; reanalysisOf?: MediaType },
): void => {
    const left = budgetRemaining(ctx);
    if ((need.aiRequests ?? 0) > left.aiRequests) throw exhausted("The AI request");
    if ((need.segmentInspections ?? 0) > left.segmentInspections) throw exhausted("The segment inspection");
    if ((need.frames ?? 0) > left.framesAnalyzed) throw exhausted("The analysed-frames");
    if (need.reanalysisOf && left.reanalyses[need.reanalysisOf] < 1)
        throw exhausted(`The ${need.reanalysisOf} re-analysis`);
};

/** Record consumed budget on the context and the inspection document (saved with the tool log). */
export const consumeBudget = (
    ctx: AgentContext,
    used: { aiRequests?: number; segmentInspections?: number; frames?: number; reanalysisOf?: MediaType },
): void => {
    ctx.budget.aiRequests += used.aiRequests ?? 0;
    ctx.budget.segmentInspections += used.segmentInspections ?? 0;
    ctx.budget.framesAnalyzed += used.frames ?? 0;
    if (used.reanalysisOf) ctx.budget.reanalyses[used.reanalysisOf] += 1;
    ctx.inspection.set("budgetUsage", { ...ctx.budget, reanalyses: { ...ctx.budget.reanalyses } });
};

/**
 * New evidence makes earlier conclusions stale: the final verification must run again (after a fresh
 * comparison) before a claim can be drafted.
 */
export const invalidateVerification = (ctx: AgentContext): void => {
    ctx.finalValidation = undefined;
    ctx.inspection.set("evidenceValidation", { initial: ctx.initialValidation ?? null, final: null });
};
