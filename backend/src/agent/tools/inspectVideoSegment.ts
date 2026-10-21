import { z } from "zod";
import { env } from "../../config/env";
import { MediaEvidence } from "../../models/MediaEvidence";
import { activeMediaFor } from "../../services/evidenceValidationService";
import { extractSegmentFrames } from "../../services/videoProcessingService";
import { inspectSegmentFrames } from "../../services/visionService";
import { ApiError } from "../../utils/errors";
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

const schema = z
    .object({
        evidenceType: evidenceTypeSchema,
        startSeconds: z.number().min(0),
        endSeconds: z.number().positive(),
        question: z
            .string()
            .trim()
            .min(10)
            .max(300)
            .describe("The specific visual question this segment should answer"),
        frameCount: z.number().int().min(1).max(12).optional(),
    })
    .strict();

/** Fraction of the shorter range covered by the overlap of two ranges. */
const overlapRatio = (a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }) => {
    const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
    const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
    return overlap > 0 && shorter > 0 ? overlap / shorter : 0;
};

const normalizeQuestion = (q: string) =>
    q
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

/**
 * Rejects repeated work: the same range again, or a mostly overlapping range with the same question.
 * Asking a genuinely different question about an overlapping range is allowed.
 */
const assertNotDuplicate = (ctx: AgentContext, args: z.infer<typeof schema>) => {
    const requested = { startSec: args.startSeconds, endSec: args.endSeconds };
    for (const done of ctx.segmentInspections.filter((s) => s.evidenceType === args.evidenceType)) {
        const sameRange =
            Math.abs(done.startSec - requested.startSec) < 0.05 && Math.abs(done.endSec - requested.endSec) < 0.05;
        const mostlySame =
            overlapRatio(done, requested) >= 0.8 &&
            normalizeQuestion(done.question) === normalizeQuestion(args.question);
        if (sameRange || mostlySame) {
            throw new ApiError(
                "DUPLICATE_SEGMENT",
                `Segment ${done.segmentId} (${done.startSec}-${done.endSec}s of the ${args.evidenceType} video) was already inspected` +
                    `${sameRange ? "" : " with the same question"}; its answer was: "${done.result.answer}"`,
                [{ retryable: false }],
            );
        }
    }
};

export const inspectVideoSegmentTool = defineTool({
    name: "inspect_video_segment",
    description:
        "Take a closer look at one short time range of the outbound or return video when the evidence so far is unclear " +
        `(e.g. an attribute is uncertain or not verifiable). Extracts up to ${env.MAX_FRAMES_PER_SEGMENT} extra frames from at most ` +
        `${env.MAX_SEGMENT_SECONDS} s of video (existing frames are never replaced) and asks the vision model one specific ` +
        "question about them. Returns the answer with a verdict (confirmed / not_present / inconclusive) and supporting frame " +
        "IDs. Uses the inspection's limited re-inspection budget. Afterwards, re-run analyze_item with includeSegmentFrames=true " +
        "to fold the new frames into the analysis, then compare_items and validate_evidence again.",
    schema,
    plannerVisible: true,
    // Each distinct range is its own retry bucket: inspecting a second segment is not a retry of the first.
    attemptKey: (args) => `${args.evidenceType}:${args.startSeconds}-${args.endSeconds}`,
    handler: async (args, ctx) => {
        if (!ctx.extraction[args.evidenceType]) {
            throw new ApiError("INVALID_STATE", `Extract the baseline ${args.evidenceType} frames first`, [
                { retryable: false },
            ]);
        }
        assertNotDuplicate(ctx, args);
        const frameCount = args.frameCount ?? env.MAX_FRAMES_PER_SEGMENT;
        assertBudget(ctx, { aiRequests: 1, segmentInspections: 1, frames: frameCount });

        const order = await refreshOrder(ctx);
        const media = await activeMediaFor(order, args.evidenceType);
        if (!media)
            throw new ApiError("VALIDATION_ERROR", `No ${args.evidenceType} evidence is linked`, [
                { retryable: false },
            ]);

        const segment = await extractSegmentFrames(media.id, {
            startSec: args.startSeconds,
            endSec: args.endSeconds,
            count: frameCount,
            inspectionId: ctx.inspection.id,
            question: args.question,
        });
        const withSegment = (await MediaEvidence.findById(media._id))!;

        // The AI request is charged before the call: a failed call still used the provider quota.
        consumeBudget(ctx, { aiRequests: 1 });
        const record = await inspectSegmentFrames(
            withSegment,
            order,
            {
                segmentId: segment.segmentId,
                startSec: segment.startSec,
                endSec: segment.endSec,
                question: args.question,
            },
            { deadlineMs: ctx.toolDeadline ?? ctx.deadline },
        );
        consumeBudget(ctx, { segmentInspections: 1, frames: record.framesAnalyzed.length });

        ctx.segmentInspections.push(record);
        ctx.inspection.segmentInspections.push(record);
        invalidateVerification(ctx);
        ctx.media[args.evidenceType] = withSegment;
        await ctx.inspection.save();
        await transition(
            ctx,
            "ADDITIONAL_INSPECTION",
            `Inspected ${args.evidenceType} ${segment.startSec}-${segment.endSec}s`,
        );

        return {
            segmentId: segment.segmentId,
            evidenceType: args.evidenceType,
            startSec: segment.startSec,
            endSec: segment.endSec,
            reusedExtraction: segment.cached,
            frames: record.framesAnalyzed,
            question: args.question,
            verdict: record.result.verdict,
            answer: record.result.answer,
            observations: record.result.observations,
            imageConditions: record.result.imageConditions,
            overallConfidence: record.result.overallConfidence,
            uncertaintyNotes: record.result.uncertaintyNotes,
            // Text from the footage is reduced to a count so it can never reach the planner as instructions.
            instructionLikeTextFound: record.result.suspectedInstructionText.length,
            validationNotes: record.validationNotes,
            source: record.source,
            budgetRemaining: budgetRemaining(ctx),
            nextStep:
                "analyze_item with includeSegmentFrames=true to fold these frames into the analysis, then compare_items " +
                "and validate_evidence; or notify_human if the evidence is still insufficient",
        };
    },
});
