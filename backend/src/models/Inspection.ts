import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const INSPECTION_RUN_STATUSES = ["pending", "processing", "needs_review", "completed", "failed"] as const;
export type InspectionStatus = (typeof INSPECTION_RUN_STATUSES)[number];

export const WORKFLOW_STATES = [
    "RECEIVED",
    "ORDER_LOOKUP",
    "EVIDENCE_VALIDATION",
    "FRAME_EXTRACTION",
    "ITEM_ANALYSIS",
    "COMPARISON",
    "VERIFICATION",
    "ADDITIONAL_INSPECTION",
    "CLAIM_DRAFT",
    "HUMAN_REVIEW",
    "COMPLETED",
    "FAILED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

const AgentLogSchema = new Schema(
    {
        at: { type: Date, default: Date.now },
        attempt: Number,
        iteration: Number,
        kind: {
            type: String,
            enum: ["state", "planner", "tool_call", "tool_result", "guardrail", "error", "note"],
            required: true,
        },
        state: String,
        tool: String,
        args: Schema.Types.Mixed,
        result: Schema.Types.Mixed,
        error: String,
        message: String,
        durationMs: Number,
        /** Which planner made (or would have made) this decision: gemini | anthropic | deterministic. */
        planner: String,
        selectedTools: { type: [String], default: undefined },
        /** The planner's own one-line justification for its tool choice (LLM planners only). */
        rationale: String,
        fallbackUsed: Boolean,
        /** Why a fallback or human review happened. */
        reason: String,
    },
    { _id: false },
);

const FrameRefSchema = new Schema(
    { frameId: String, mediaId: String, type: { type: String }, timestampSec: Number },
    { _id: false },
);

const InspectionSchema = new Schema(
    {
        orderId: { type: String, required: true, index: true },
        orderRef: { type: Schema.Types.ObjectId, ref: "Order", required: true },
        shopId: { type: String, required: true, index: true },
        warehouseId: { type: String, required: true },
        task: { type: String, required: true },
        attempt: { type: Number, default: 1 },
        status: { type: String, enum: INSPECTION_RUN_STATUSES, default: "pending" },
        workflowState: { type: String, enum: WORKFLOW_STATES, default: "RECEIVED" },
        stateHistory: [
            { _id: false, state: String, at: { type: Date, default: Date.now }, note: String, attempt: Number },
        ],
        analysisMode: { type: String, enum: ["real", "demo"], required: true },
        planner: { type: String, enum: ["llm", "deterministic"], required: true },
        evidenceValidation: { type: Schema.Types.Mixed },
        /** Targeted segment inspections requested by the agent (adaptive re-inspection), in order. */
        segmentInspections: { type: [Schema.Types.Mixed], default: [] },
        /** Analyses replaced by a re-analysis; kept so earlier frame citations stay auditable. */
        analysisHistory: { type: [Schema.Types.Mixed], default: [] },
        /** AI requests, segment inspections, frames analysed and re-analyses consumed by this run. */
        budgetUsage: { type: Schema.Types.Mixed },
        outboundAnalysis: { type: Schema.Types.Mixed },
        returnAnalysis: { type: Schema.Types.Mixed },
        comparison: { type: Schema.Types.Mixed },
        /** Model-reported confidence is stored as-is; it is NOT treated as a calibrated probability. */
        confidence: {
            score: Number,
            threshold: Number,
            meetsThreshold: Boolean,
            calibrated: { type: Boolean, default: false },
        },
        uncertainty: { type: [String], default: [] },
        frameReferences: { type: [FrameRefSchema], default: [] },
        escalation: {
            required: { type: Boolean, default: false },
            blocking: { type: Boolean, default: false },
            reasons: { type: [String], default: [] },
        },
        reviewTask: {
            status: { type: String, enum: ["open", "resolved"] },
            reason: String,
            reasons: [String],
            findings: Schema.Types.Mixed,
            requiredAction: String,
            createdAt: Date,
            resolvedAt: Date,
            resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
            resolutionNote: String,
        },
        /** Deterministic summary built from structured results (the official outcome). */
        summary: { type: String },
        /** Free-text closing message from the LLM planner, shown separately and never used for decisions. */
        agentNarrative: { type: String },
        plannerFallback: { type: Boolean, default: false },
        /** Planner that produced the final decisions (after any fallback). */
        plannerUsed: { type: String, enum: ["gemini", "anthropic", "deterministic"] },
        /** One-glance provenance label for UI, logs and reports. */
        executionLabel: { type: String, enum: ["REAL_GEMINI", "REAL_ANTHROPIC", "DEMO", "DETERMINISTIC_FALLBACK"] },
        recommendedAction: { type: String },
        claimId: { type: Schema.Types.ObjectId, ref: "Claim" },
        agentLog: { type: [AgentLogSchema], default: [] },
        error: { type: String },
        requestedBy: { type: Schema.Types.ObjectId, ref: "User" },
        startedAt: Date,
        finishedAt: Date,
    },
    { timestamps: true },
);

export type InspectionAttrs = InferSchemaType<typeof InspectionSchema>;
export type InspectionDoc = HydratedDocument<InspectionAttrs>;
export const Inspection = model("Inspection", InspectionSchema);
