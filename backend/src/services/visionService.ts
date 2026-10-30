import crypto from "node:crypto";
import { z } from "zod";
import { buildVisionUserText, VISION_SYSTEM_PROMPT } from "../agent/prompts";
import {
    normalizeAnalysis,
    normalizeSegmentObservation,
    SegmentObservationSchema,
    VisionAnalysisSchema,
    type AnalysisRecord,
    type SegmentInspectionRecord,
} from "../agent/schemas";
import { activeModels, env } from "../config/env";
import { MediaEvidence, type MediaDoc } from "../models/MediaEvidence";
import type { OrderDoc } from "../models/Order";
import { ApiError, errorMessage } from "../utils/errors";
import { logger } from "../utils/logger";
import { aiError } from "./vision/errors";
import { getVisionProvider } from "./vision";
import type { VisionFrame } from "./vision/types";
import { storage } from "./storageService";
import { isBaselineFrame } from "./videoProcessingService";

type Frame = MediaDoc["frames"][number];

/** With fewer clear frames than this the model gets all of them: dark or blurry frames beat too few frames. */
const MIN_CLEAR_FRAMES = 3;

/** Pick up to `max` frames spread across the video, leaving out frames that failed the quality check. */
export const selectFrames = (frames: Frame[], max: number): Frame[] => {
    const clear = frames.filter((f) => f.quality === "ok");
    const pool = clear.length >= MIN_CLEAR_FRAMES ? clear : frames;
    if (pool.length <= max) return [...pool];
    const step = pool.length / max;
    const picked = Array.from({ length: max }, (_, i) => pool[Math.floor(i * step)]);
    return picked.sort((a, b) => a.index - b.index);
};

const loadFrames = (frames: Frame[]): Promise<VisionFrame[]> =>
    Promise.all(
        frames.map(async (f) => ({
            frameId: f.frameId,
            timestampSec: f.timestampSec,
            jpeg: await storage().readBuffer(f.storageKey),
        })),
    );

export interface AnalyzeOptions {
    deadlineMs?: number;
    /**
     * Segment frame IDs to include in addition to the baseline frames (re-analysis after a targeted
     * inspection). Baseline frames alone are used when omitted.
     */
    extraFrameIds?: string[];
}

/** Analyse the extracted frames of one evidence video with the configured vision provider. */
export const analyzeEvidence = async (
    media: MediaDoc,
    order: OrderDoc,
    options: AnalyzeOptions = {},
): Promise<AnalysisRecord> => {
    if (media.status !== "processed" || media.frames.length === 0) {
        throw new ApiError("INVALID_STATE", `Frames have not been extracted for ${media.type} evidence ${media.id}`);
    }
    // Baseline frames, plus segment frames only when a re-inspection explicitly asks for them.
    const baseline = selectFrames(media.frames.filter(isBaselineFrame), env.MAX_FRAMES_PER_ANALYSIS);
    const wanted = new Set(options.extraFrameIds ?? []);
    const extra = media.frames.filter((f) => !isBaselineFrame(f) && wanted.has(f.frameId));
    if (extra.length !== wanted.size) {
        throw new ApiError("VALIDATION_ERROR", `Unknown segment frames for ${media.type} evidence`, [
            { retryable: false },
        ]);
    }
    const frames = await loadFrames([...baseline, ...extra]);

    // product.name is required by the schema; Mongoose's inferred type just doesn't express that for nested paths.
    const product = order.product!;
    const provider = getVisionProvider();
    const response = await provider.analyze({
        evidenceType: media.type,
        frames,
        deadlineMs: options.deadlineMs,
        expected: {
            productName: product.name,
            productDescription: product.description || undefined,
            expectedQuantity: order.expectedQuantity,
            expectedAccessories: order.expectedAccessories,
        },
        demoContext:
            provider.source === "demo"
                ? {
                      scenario: order.demoScenario ?? undefined,
                      color: product.color ?? undefined,
                      model: product.model ?? undefined,
                  }
                : undefined,
    });

    // Re-validate regardless of provider: the agent must never act on output that breaks the schema.
    const parsed = VisionAnalysisSchema.safeParse(response.analysis);
    if (!parsed.success) {
        throw aiError(`Vision output failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`, true);
    }
    const { result, notes } = normalizeAnalysis(
        parsed.data,
        frames.map((f) => f.frameId),
    );

    return {
        mediaId: media.id,
        evidenceType: media.type,
        source: provider.source,
        model: response.model,
        framesAnalyzed: frames.map((f) => ({ frameId: f.frameId, timestampSec: f.timestampSec })),
        analyzedAt: new Date().toISOString(),
        result,
        validationNotes: notes,
        ...(response.usage ? { usage: response.usage } : {}),
    };
};

const ANALYSIS_CONTRACT = JSON.stringify([VISION_SYSTEM_PROMPT, z.toJSONSchema(VisionAnalysisSchema)]);

/** Everything an analysis depends on, so changing the prompt, schema, model, frames or checklist runs it again. */
const analysisKey = (media: MediaDoc, order: OrderDoc): string => {
    const frames = selectFrames(media.frames.filter(isBaselineFrame), env.MAX_FRAMES_PER_ANALYSIS);
    const product = order.product!;
    return crypto
        .createHash("sha256")
        .update(
            JSON.stringify({
                contract: ANALYSIS_CONTRACT,
                provider: getVisionProvider().source,
                model: activeModels(env)?.vision,
                thinking: [env.GEMINI_THINKING_LEVEL ?? null, env.AI_EFFORT],
                checklist: buildVisionUserText({
                    evidenceType: media.type,
                    productName: product.name,
                    productDescription: product.description || undefined,
                    expectedQuantity: order.expectedQuantity,
                    expectedAccessories: order.expectedAccessories,
                    frameCount: frames.length,
                }),
                frames: frames.map((f) => [f.frameId, f.timestampSec, f.sharpness]),
            }),
        )
        .digest("hex");
};

/** The stored analysis of this video, if it is still valid for this order and configuration. */
export const findReusableAnalysis = (media: MediaDoc, order: OrderDoc): AnalysisRecord | null => {
    const cache = media.analysisCache as { key?: string; record?: AnalysisRecord } | undefined;
    if (!env.AI_ANALYSIS_CACHE || !cache?.record || cache.key !== analysisKey(media, order)) return null;
    return { ...cache.record, reused: true };
};

/**
 * Keep a good AI analysis for later runs. A weak one is not kept: running the inspection again is then a real
 * second attempt. Failing to store it must not fail the analysis.
 */
export const rememberAnalysis = async (media: MediaDoc, order: OrderDoc, record: AnalysisRecord): Promise<void> => {
    const { overallConfidence, imageConditions } = record.result;
    const usable = imageConditions.lighting !== "unusable" && imageConditions.focus !== "unusable";
    if (record.source !== "ai" || overallConfidence < env.CONFIDENCE_THRESHOLD || !usable) return;
    try {
        await MediaEvidence.updateOne(
            { _id: media._id },
            { $set: { analysisCache: { key: analysisKey(media, order), record } } },
        );
    } catch (error) {
        logger.warn("Could not store the analysis for reuse", { mediaId: media.id, error: errorMessage(error) });
    }
};

/** Ask the vision provider one targeted question about the frames of one extracted segment. */
export const inspectSegmentFrames = async (
    media: MediaDoc,
    order: OrderDoc,
    segment: { segmentId: string; startSec: number; endSec: number; question: string },
    options: { deadlineMs?: number } = {},
): Promise<SegmentInspectionRecord> => {
    const segmentFrames = media.frames.filter((f) => f.segmentId === segment.segmentId);
    if (segmentFrames.length === 0) {
        throw new ApiError("INVALID_STATE", `Segment ${segment.segmentId} has no frames`, [{ retryable: false }]);
    }
    const provider = getVisionProvider();
    if (!provider.inspectSegment) {
        throw aiError("The configured vision provider does not support targeted segment inspection", false);
    }
    const frames = await loadFrames(segmentFrames);
    const response = await provider.inspectSegment({
        evidenceType: media.type,
        frames,
        startSec: segment.startSec,
        endSec: segment.endSec,
        question: segment.question,
        productName: order.product!.name,
        deadlineMs: options.deadlineMs,
        demoContext: provider.source === "demo" ? { scenario: order.demoScenario ?? undefined } : undefined,
    });

    const parsed = SegmentObservationSchema.safeParse(response.observation);
    if (!parsed.success) {
        throw aiError(`Segment output failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`, true);
    }
    const { result, notes } = normalizeSegmentObservation(
        parsed.data,
        frames.map((f) => f.frameId),
    );
    return {
        segmentId: segment.segmentId,
        mediaId: media.id,
        evidenceType: media.type,
        startSec: segment.startSec,
        endSec: segment.endSec,
        question: segment.question,
        source: provider.source,
        model: response.model,
        framesAnalyzed: frames.map((f) => ({ frameId: f.frameId, timestampSec: f.timestampSec })),
        inspectedAt: new Date().toISOString(),
        result,
        validationNotes: notes,
        ...(response.usage ? { usage: response.usage } : {}),
    };
};
