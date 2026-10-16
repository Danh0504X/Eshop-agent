import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { MediaEvidence, type MediaDoc } from "../models/MediaEvidence";
import { ApiError, errorMessage } from "../utils/errors";
import { extractFrameAt, frameMetrics, maxTimestampGap, probeVideo } from "./ffmpegService";
import { safeSegment, storage } from "./storageService";

export type FrameQuality = "ok" | "dark" | "blurry" | "dark_and_blurry";

export interface ExtractionResult {
    mediaId: string;
    type: string;
    cached: boolean;
    durationSec: number;
    frames: Array<{
        frameId: string;
        timestampSec: number;
        quality: FrameQuality;
        brightness: number;
        sharpness: number;
    }>;
    quality: { darkFrameRatio: number; blurryFrameRatio: number; maxTimestampGapSec: number; continuous: boolean };
}

export const classifyFrame = (brightness: number, sharpness: number): FrameQuality => {
    const dark = brightness < env.MIN_FRAME_BRIGHTNESS;
    const blurry = sharpness < env.MIN_FRAME_SHARPNESS;
    if (dark && blurry) return "dark_and_blurry";
    if (dark) return "dark";
    if (blurry) return "blurry";
    return "ok";
};

/** Evenly spaced sample points, avoiding the very first and last instants (often black or cut). */
export const sampleTimestamps = (durationSec: number, count: number): number[] =>
    Array.from({ length: count }, (_, i) => Number((((i + 0.5) * durationSec) / count).toFixed(3)));

const toResult = (media: MediaDoc, cached: boolean): ExtractionResult => ({
    mediaId: media.id,
    type: media.type,
    cached,
    durationSec: media.metadata?.durationSec ?? 0,
    frames: media.frames.map((f) => ({
        frameId: f.frameId,
        timestampSec: f.timestampSec,
        quality: f.quality as FrameQuality,
        brightness: Math.round(f.brightness ?? 0),
        sharpness: Math.round(f.sharpness ?? 0),
    })),
    quality: {
        darkFrameRatio: media.quality?.darkFrameRatio ?? 0,
        blurryFrameRatio: media.quality?.blurryFrameRatio ?? 0,
        maxTimestampGapSec: media.quality?.maxTimestampGapSec ?? 0,
        continuous: media.quality?.continuous ?? false,
    },
});

/** Confirm frames recorded in the database actually exist in storage. */
export const verifyFramesOnDisk = async (media: MediaDoc): Promise<string[]> => {
    const missing: string[] = [];
    for (const frame of media.frames) {
        if (!(await storage().exists(frame.storageKey))) missing.push(frame.frameId);
    }
    return missing;
};

/**
 * Probe a stored video, enforce size/duration limits, extract representative frames with quality metrics,
 * and persist everything on the MediaEvidence record. Idempotent unless `force` is set.
 */
export const extractFrames = async (mediaId: string, options: { force?: boolean } = {}): Promise<ExtractionResult> => {
    const media = await MediaEvidence.findById(mediaId);
    if (!media || media.status === "deleted") throw new ApiError("NOT_FOUND", "Media evidence not found");
    if (media.status === "superseded") throw new ApiError("INVALID_STATE", "Media has been superseded");

    if (!options.force && media.status === "processed" && media.frames.length > 0) {
        const missing = await verifyFramesOnDisk(media);
        if (missing.length === 0) return toResult(media, true);
    }

    const store = storage();
    if (!(await store.exists(media.storageKey))) {
        await markFailed(media, "Evidence file is missing from storage");
        throw new ApiError("PROCESSING_ERROR", "Evidence file is missing from storage");
    }
    const sizeBytes = await store.size(media.storageKey);
    if (sizeBytes > env.MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
        await markFailed(media, "File exceeds the configured size limit");
        throw new ApiError("PAYLOAD_TOO_LARGE", `File exceeds the ${env.MAX_UPLOAD_SIZE_MB} MB processing limit`);
    }

    media.status = "processing";
    media.extractionAttempts += 1;
    media.processingError = undefined;
    await media.save();

    const videoPath = store.localPath(media.storageKey);
    try {
        const probe = await probeVideo(videoPath);
        if (probe.durationSec > env.MAX_VIDEO_DURATION_SEC) {
            throw new ApiError(
                "PROCESSING_ERROR",
                `Video is ${probe.durationSec.toFixed(1)} s; the limit is ${env.MAX_VIDEO_DURATION_SEC} s`,
            );
        }
        if (probe.durationSec < env.MIN_VIDEO_DURATION_SEC) {
            throw new ApiError(
                "PROCESSING_ERROR",
                `Video is only ${probe.durationSec.toFixed(1)} s; at least ${env.MIN_VIDEO_DURATION_SEC} s is required`,
            );
        }

        const prefix = media.type === "outbound" ? "OUT" : "RET";
        const keyBase = `frames/${safeSegment(media.shopId)}/${safeSegment(media.orderId)}/${media.id}`;
        // Remove frames from a previous attempt so stale images can never be cited.
        for (const old of media.frames) await store.delete(old.storageKey);

        const frames = [];
        for (const [index, timestampSec] of sampleTimestamps(probe.durationSec, env.FRAMES_PER_VIDEO).entries()) {
            const frameId = `${prefix}-${String(index + 1).padStart(2, "0")}`;
            const storageKey = `${keyBase}/${frameId}.jpg`;
            const outPath = store.localPath(storageKey);
            await fsp.mkdir(path.dirname(outPath), { recursive: true });
            await extractFrameAt(videoPath, timestampSec, outPath);
            const metrics = await frameMetrics(outPath);
            frames.push({
                frameId,
                index,
                timestampSec,
                storageKey,
                brightness: metrics.brightness,
                sharpness: metrics.sharpness,
                quality: classifyFrame(metrics.brightness, metrics.sharpness),
            });
        }

        const gap = await maxTimestampGap(videoPath);
        const dark = frames.filter((f) => f.quality === "dark" || f.quality === "dark_and_blurry").length;
        const blurry = frames.filter((f) => f.quality === "blurry" || f.quality === "dark_and_blurry").length;

        media.set({
            metadata: { ...probe, probedAt: new Date() },
            frames,
            quality: {
                darkFrameRatio: dark / frames.length,
                blurryFrameRatio: blurry / frames.length,
                maxTimestampGapSec: Number(gap.toFixed(3)),
                continuous: gap <= env.MAX_TIMESTAMP_GAP_SEC,
                assessedAt: new Date(),
            },
            status: "processed",
        });
        await media.save();
    } catch (error) {
        await markFailed(media, errorMessage(error));
        throw error instanceof ApiError ? error : new ApiError("PROCESSING_ERROR", errorMessage(error));
    }

    // Read back from the database and storage rather than trusting in-memory state.
    const persisted = await MediaEvidence.findById(media._id);
    if (!persisted || persisted.status !== "processed" || persisted.frames.length !== env.FRAMES_PER_VIDEO) {
        throw new ApiError("PROCESSING_ERROR", "Extracted frames were not persisted");
    }
    const missing = await verifyFramesOnDisk(persisted);
    if (missing.length > 0) throw new ApiError("PROCESSING_ERROR", `Frames missing on disk: ${missing.join(", ")}`);
    return toResult(persisted, false);
};

const markFailed = async (media: MediaDoc, message: string) => {
    await MediaEvidence.updateOne({ _id: media._id }, { $set: { status: "failed", processingError: message } });
};
