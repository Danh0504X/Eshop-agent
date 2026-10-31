import { z } from "zod";
import type { AnalysisRecord } from "../schemas";
import { env } from "../../config/env";
import type { MediaDoc } from "../../models/MediaEvidence";
import type { OrderDoc } from "../../models/Order";
import { activeMediaFor } from "../../services/evidenceValidationService";
import {
    analyzeEvidence,
    findReusableAnalysis,
    rememberAnalysis,
    type AnalyzeOptions,
} from "../../services/visionService";
import { ApiError } from "../../utils/errors";
import { trace } from "../agentTrace";
import {
    assertBudget,
    budgetRemaining,
    consumeBudget,
    invalidateVerification,
    transition,
    type AgentContext,
} from "../agentState";
import { evidenceTypeSchema, refreshOrder } from "./helpers";
import { defineTool } from "./types";

/**
 * What the planner sees of an analysis. Text found in the footage that looked like instructions is
 * reduced to a count so it can never reach the planner's context as a prompt-injection vector.
 */
export const summarizeAnalysis = (record: AnalysisRecord) => {
    const a = record.result;
    return {
        evidenceType: record.evidenceType,
        source: record.source,
        reused: Boolean(record.reused),
        framesAnalyzed: record.framesAnalyzed,
        packageContents: a.packageContents,
        items: a.items.map((i) => ({
            description: i.description,
            productType: i.productType,
            quantity: i.quantity,
            color: i.color,
            model: i.model,
            condition: i.condition,
        })),
        totalItemCount: a.totalItemCount,
        accessories: a.accessories,
        packagingCondition: a.packagingCondition,
        imageConditions: a.imageConditions,
        overallConfidence: a.overallConfidence,
        uncertaintyNotes: a.uncertaintyNotes,
        instructionLikeTextFound: a.suspectedInstructionText.length,
        validationNotes: record.validationNotes,
    };
};

/** Segment frames inspected in this run for one video that the current analysis has not seen yet. */
const unseenSegmentFrames = (ctx: AgentContext, evidenceType: "outbound" | "return"): string[] => {
    const seen = new Set(ctx.analyses[evidenceType]?.framesAnalyzed.map((f) => f.frameId) ?? []);
    return ctx.segmentInspections
        .filter((s) => s.evidenceType === evidenceType)
        .flatMap((s) => s.framesAnalyzed.map((f) => f.frameId))
        .filter((id) => !seen.has(id));
};

/** One vision request; a good first analysis of a video is kept for later runs on the same evidence. */
const requestAnalysis = async (media: MediaDoc, order: OrderDoc, options: AnalyzeOptions): Promise<AnalysisRecord> => {
    const record = await analyzeEvidence(media, order, options);
    if (!options.extraFrameIds?.length) await rememberAnalysis(media, order, record);
    return record;
};

/**
 * Start the other video's first analysis now, so both run at the same time; its own analyze_item call then only
 * waits for the result. Tools still run one at a time, so the workflow and the trace stay in order.
 */
const startOtherVideo = async (ctx: AgentContext, type: "outbound" | "return", order: OrderDoc, ownFrames: number) => {
    const other = type === "outbound" ? "return" : "outbound";
    const extraction = ctx.extraction[other];
    if (!extraction || ctx.analyses[other] || ctx.pendingAnalyses[other]) return;
    const media = await activeMediaFor(order, other);
    if (!media || findReusableAnalysis(media, order)) return;
    const frames = Math.min(extraction.frames.length, env.MAX_FRAMES_PER_ANALYSIS);
    const left = budgetRemaining(ctx);
    if (left.aiRequests < 1 || left.framesAnalyzed < ownFrames + frames) return;

    consumeBudget(ctx, { aiRequests: 1 });
    trace(`  ... analysing the ${other} video at the same time`);
    const pending = requestAnalysis(media, order, { deadlineMs: ctx.toolDeadline ?? ctx.deadline });
    // A failure is reported by that video's analyze_item call; the run may also end before it gets there.
    pending.catch(() => undefined);
    ctx.pendingAnalyses[other] = pending;
};

const schema = z
    .object({
        evidenceType: evidenceTypeSchema,
        includeSegmentFrames: z
            .boolean()
            .optional()
            .describe("Re-analyse with the frames from segments inspected in this run (after inspect_video_segment)"),
    })
    .strict();

export const analyzeItemTool = defineTool({
    name: "analyze_item",
    description:
        "Analyse the extracted frames of one evidence video with the vision model. Returns visible product type, quantity, " +
        "colour, model, product condition (visible damage), accessories, packaging condition and image conditions, each " +
        "marked observed/uncertain/not_visible with supporting frame IDs. Call once for outbound and once for return. " +
        "After inspect_video_segment, call again with includeSegmentFrames=true to re-analyse that video with the extra " +
        "frames (limited re-analysis budget; the previous analysis is kept in the history).",
    schema,
    plannerVisible: true,
    // Initial analysis and re-analysis are separate retry buckets.
    attemptKey: (args) => `${args.evidenceType}${args.includeSegmentFrames ? ":with-segments" : ""}`,
    handler: async (args, ctx) => {
        const type = args.evidenceType;
        if (!ctx.extraction[type]) {
            throw new ApiError("INVALID_STATE", `Extract ${type} frames first`, [{ retryable: false }]);
        }
        const previous = ctx.analyses[type];
        const extraFrameIds = previous ? unseenSegmentFrames(ctx, type) : [];
        if (previous) {
            // Re-analysis is only meaningful with new evidence, and only inside the re-inspection loop.
            if (ctx.state !== "ADDITIONAL_INSPECTION" || !args.includeSegmentFrames) {
                throw new ApiError(
                    "INVALID_STATE",
                    `The ${type} video is already analysed. To re-analyse, inspect a segment first and call analyze_item with includeSegmentFrames=true.`,
                    [{ retryable: false }],
                );
            }
            if (extraFrameIds.length === 0) {
                throw new ApiError("INVALID_STATE", `No new segment frames of the ${type} video to analyse`, [
                    { retryable: false },
                ]);
            }
        }
        const order = await refreshOrder(ctx);
        const media = await activeMediaFor(order, type);
        if (!media) throw new ApiError("VALIDATION_ERROR", `No ${type} evidence is linked`, [{ retryable: false }]);

        const pending = ctx.pendingAnalyses[type];
        delete ctx.pendingAnalyses[type];
        let record = pending ? await pending : previous ? null : findReusableAnalysis(media, order);
        if (!record) {
            const frameCount =
                Math.min(ctx.extraction[type]!.frames.length, env.MAX_FRAMES_PER_ANALYSIS) + extraFrameIds.length;
            assertBudget(ctx, { aiRequests: 1, frames: frameCount, ...(previous ? { reanalysisOf: type } : {}) });
            // The AI request is charged before the call: a failed call still used the provider quota.
            consumeBudget(ctx, { aiRequests: 1 });
            if (!previous) await startOtherVideo(ctx, type, order, frameCount);
            record = await requestAnalysis(media, order, {
                deadlineMs: ctx.toolDeadline ?? ctx.deadline,
                extraFrameIds,
            });
        }
        if (!record.reused) {
            consumeBudget(ctx, { frames: record.framesAnalyzed.length, ...(previous ? { reanalysisOf: type } : {}) });
        }

        if (previous) {
            // Earlier citations stay auditable: the replaced analysis is kept, never overwritten in place.
            ctx.inspection.analysisHistory.push({ ...previous, replacedAt: new Date().toISOString() });
            invalidateVerification(ctx);
        }
        ctx.analyses[type] = record;
        ctx.inspection.set(type === "outbound" ? "outboundAnalysis" : "returnAnalysis", record);
        await ctx.inspection.save();

        if (!previous && ctx.analyses.outbound && ctx.analyses.return) {
            await transition(ctx, "ITEM_ANALYSIS", "Both evidence videos analysed");
        }
        return {
            ...summarizeAnalysis(record),
            reanalysis: Boolean(previous),
            segmentFramesIncluded: extraFrameIds,
            framesExtracted: ctx.extraction[type]!.frames.length,
            budgetRemaining: budgetRemaining(ctx),
            nextStep: previous
                ? "compare_items to compare with the updated analysis, then validate_evidence"
                : ctx.analyses.outbound && ctx.analyses.return
                  ? "compare_items"
                  : "analyze_item for the other evidence type",
        };
    },
});
