import { normalizeAnalysis, VisionAnalysisSchema, type AnalysisRecord } from "../agent/schemas";
import { env } from "../config/env";
import type { MediaDoc } from "../models/MediaEvidence";
import type { OrderDoc } from "../models/Order";
import { ApiError } from "../utils/errors";
import { aiError } from "./vision/anthropicVisionProvider";
import { getVisionProvider } from "./vision";
import { storage } from "./storageService";

type Frame = MediaDoc["frames"][number];

/** Pick up to `max` frames spread across the video, preferring frames that passed the quality check. */
export const selectFrames = (frames: Frame[], max: number): Frame[] => {
    if (frames.length <= max) return [...frames];
    const good = frames.filter((f) => f.quality === "ok");
    const pool = good.length >= max ? good : frames;
    const step = pool.length / max;
    const picked = Array.from({ length: max }, (_, i) => pool[Math.floor(i * step)]);
    return picked.sort((a, b) => a.index - b.index);
};

/** Analyse the extracted frames of one evidence video with the configured vision provider. */
export const analyzeEvidence = async (media: MediaDoc, order: OrderDoc): Promise<AnalysisRecord> => {
    if (media.status !== "processed" || media.frames.length === 0) {
        throw new ApiError("INVALID_STATE", `Frames have not been extracted for ${media.type} evidence ${media.id}`);
    }
    const selected = selectFrames(media.frames, env.MAX_FRAMES_PER_ANALYSIS);
    const frames = await Promise.all(
        selected.map(async (f) => ({
            frameId: f.frameId,
            timestampSec: f.timestampSec,
            jpeg: await storage().readBuffer(f.storageKey),
        })),
    );

    // product.name is required by the schema; Mongoose's inferred type just doesn't express that for nested paths.
    const product = order.product!;
    const provider = getVisionProvider();
    const response = await provider.analyze({
        evidenceType: media.type,
        frames,
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
                      orderId: order.orderId,
                      trackingCode: order.trackingCode,
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
    };
};
