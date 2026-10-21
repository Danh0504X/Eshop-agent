import type { AnalysisRecord } from "./schemas";
import { env } from "../config/env";
import type { InspectionDoc, WorkflowState } from "../models/Inspection";
import type { MediaDoc, MediaType } from "../models/MediaEvidence";
import type { OrderDoc } from "../models/Order";
import type { ComparisonResult } from "../services/comparisonService";
import type { EscalationReason, EvidenceValidation } from "../services/evidenceValidationService";
import type { ExtractionResult } from "../services/videoProcessingService";
import type { AuthPrincipal } from "../types/auth";

export const TOOL_NAMES = [
    "lookup_order",
    "link_media",
    "extract_frames",
    "validate_evidence",
    "analyze_item",
    "compare_items",
    "build_claim_pack",
    "track_refund",
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
    ITEM_ANALYSIS: ["analyze_item", "compare_items", "notify_human"],
    COMPARISON: ["validate_evidence", "notify_human"],
    VERIFICATION: ["build_claim_pack", "notify_human"],
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
    pendingEscalation: [],
    reviewTaskCreated: false,
    attempts: {},
    iteration: 0,
    deadline: Date.now() + env.AGENT_TIMEOUT_MS,
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
