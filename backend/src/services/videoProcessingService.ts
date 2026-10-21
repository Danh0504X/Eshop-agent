import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { Claim } from "../models/Claim";
import { Inspection } from "../models/Inspection";
import { MediaEvidence, type MediaDoc } from "../models/MediaEvidence";
import { ApiError, errorMessage } from "../utils/errors";
import { extractFrameAt, frameMetrics, maxTimestampGap, probeVideo } from "./ffmpegService";
import { safeSegment, storage } from "./storageService";

export type FrameQuality = "ok" | "dark" | "blurry" | "dark_and_blurry";

interface FrameSummary {
    frameId: string;
    timestampSec: number;
    quality: FrameQuality;
    brightness: number;
    sharpness: number;
}

export interface ExtractionResult {
    mediaId: string;
    type: string;
    cached: boolean;
    durationSec: number;
    /** Baseline frames only (the evenly sampled set). */
    frames: FrameSummary[];
    quality: { darkFrameRatio: number; blurryFrameRatio: number; maxTimestampGapSec: number; continuous: boolean };
    /** Frames added later by targeted segment extraction (not part of the baseline set above). */
    segmentFrameCount: number;
}

type Frame = MediaDoc["frames"][number];

/** Baseline frames are the evenly sampled set; segment frames are appended by targeted re-inspection. */
export const isBaselineFrame = (frame: Pick<Frame, "origin">) => frame.origin !== "segment";

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

const summarizeFrame = (f: Frame): FrameSummary => ({
    frameId: f.frameId,
    timestampSec: f.timestampSec,
    quality: f.quality as FrameQuality,
    brightness: Math.round(f.brightness ?? 0),
    sharpness: Math.round(f.sharpness ?? 0),
});

const toResult = (media: MediaDoc, cached: boolean): ExtractionResult => ({
    mediaId: media.id,
    type: media.type,
    cached,
    durationSec: media.metadata?.durationSec ?? 0,
    frames: media.frames.filter(isBaselineFrame).map(summarizeFrame),
    quality: {
        darkFrameRatio: media.quality?.darkFrameRatio ?? 0,
        blurryFrameRatio: media.quality?.blurryFrameRatio ?? 0,
        maxTimestampGapSec: media.quality?.maxTimestampGapSec ?? 0,
        continuous: media.quality?.continuous ?? false,
    },
    segmentFrameCount: media.frames.filter((f) => !isBaselineFrame(f)).length,
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
 * Re-extracting baseline frames replaces their images. That is refused once an inspection or claim cites
 * frames of this video, because the citations would then point at different pictures.
 */
const assertBaselineNotReferenced = async (media: MediaDoc): Promise<void> => {
    const cited = await Inspection.exists({
        $or: [{ "outboundAnalysis.mediaId": media.id }, { "returnAnalysis.mediaId": media.id }],
    });
    const claimed = await Claim.exists({ "evidenceReferences.mediaId": media.id });
    if (cited || claimed) {
        throw new ApiError(
            "INVALID_STATE",
            `Frames of this ${media.type} video are already cited as evidence; re-extraction would invalidate those references. Use segment extraction to add frames instead.`,
            [{ retryable: false }],
        );
    }
};

/**
 * Probe a stored video, enforce size/duration limits, extract representative frames with quality metrics,
 * and persist everything on the MediaEvidence record. Idempotent unless `force` is set; `force` only replaces
 * baseline frames that nothing cites yet, and never touches segment frames.
 */
export const extractFrames = async (mediaId: string, options: { force?: boolean } = {}): Promise<ExtractionResult> => {
    const media = await MediaEvidence.findById(mediaId);
    if (!media || media.status === "deleted") throw new ApiError("NOT_FOUND", "Media evidence not found");
    if (media.status === "superseded") throw new ApiError("INVALID_STATE", "Media has been superseded");

    if (!options.force && media.status === "processed" && media.frames.some(isBaselineFrame)) {
        const missing = await verifyFramesOnDisk(media);
        if (missing.length === 0) return toResult(media, true);
    }
    if (options.force && media.frames.length > 0) await assertBaselineNotReferenced(media);

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
        // Remove baseline frames from a previous attempt so stale images can never be cited.
        // Segment frames are append-only evidence and are kept.
        const segmentFrames = media.frames.filter((f) => !isBaselineFrame(f));
        for (const old of media.frames.filter(isBaselineFrame)) await store.delete(old.storageKey);

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
                origin: "initial" as const,
            });
        }

        const gap = await maxTimestampGap(videoPath);
        const dark = frames.filter((f) => f.quality === "dark" || f.quality === "dark_and_blurry").length;
        const blurry = frames.filter((f) => f.quality === "blurry" || f.quality === "dark_and_blurry").length;

        media.set({
            metadata: { ...probe, probedAt: new Date() },
            frames: [...frames, ...segmentFrames],
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
    if (
        !persisted ||
        persisted.status !== "processed" ||
        persisted.frames.filter(isBaselineFrame).length !== env.FRAMES_PER_VIDEO
    ) {
        throw new ApiError("PROCESSING_ERROR", "Extracted frames were not persisted");
    }
    const missing = await verifyFramesOnDisk(persisted);
    if (missing.length > 0) throw new ApiError("PROCESSING_ERROR", `Frames missing on disk: ${missing.join(", ")}`);
    return toResult(persisted, false);
};

const markFailed = async (media: MediaDoc, message: string) => {
    await MediaEvidence.updateOne({ _id: media._id }, { $set: { status: "failed", processingError: message } });
};

// --- Targeted segment extraction ---------------------------------------------------------------------------------

export interface SegmentRequest {
    startSec: number;
    endSec: number;
    /** Frames to extract; defaults to MAX_FRAMES_PER_SEGMENT. */
    count?: number;
    inspectionId?: string;
    question?: string;
}

export interface SegmentExtractionResult {
    mediaId: string;
    type: string;
    segmentId: string;
    startSec: number;
    endSec: number;
    /** True when an identical segment had already been extracted; no new frames were created. */
    cached: boolean;
    frames: FrameSummary[];
}

/** Two segments are the same when both ends match within 10 ms. */
const SAME_BOUND_SEC = 0.01;

const segmentResult = (media: MediaDoc, segmentId: string, cached: boolean): SegmentExtractionResult => {
    const segment = media.segments.find((s) => s.segmentId === segmentId)!;
    return {
        mediaId: media.id,
        type: media.type,
        segmentId,
        startSec: segment.startSec,
        endSec: segment.endSec,
        cached,
        frames: media.frames.filter((f) => f.segmentId === segmentId).map(summarizeFrame),
    };
};

/**
 * Extract extra frames from one time range of an already processed video, for a closer look.
 * Append-only: baseline frames and earlier segments are never modified or deleted, every new frame gets a
 * unique ID (e.g. RET-S2-03) and the segment's provenance is recorded. An identical request returns the
 * existing frames. A failure here never marks the video itself as failed: the original evidence stays valid.
 */
export const extractSegmentFrames = async (
    mediaId: string,
    request: SegmentRequest,
): Promise<SegmentExtractionResult> => {
    const media = await MediaEvidence.findById(mediaId);
    if (!media || media.status === "deleted") throw new ApiError("NOT_FOUND", "Media evidence not found");
    if (media.status === "superseded") throw new ApiError("INVALID_STATE", "Media has been superseded");
    const duration = media.metadata?.durationSec;
    if (media.status !== "processed" || !duration) {
        throw new ApiError("INVALID_STATE", `Extract the baseline frames of the ${media.type} video first`, [
            { retryable: false },
        ]);
    }

    const { startSec, endSec } = request;
    const count = request.count ?? env.MAX_FRAMES_PER_SEGMENT;
    const invalid = (message: string) => new ApiError("VALIDATION_ERROR", message, [{ retryable: false }]);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) throw invalid("Segment bounds must be numbers");
    if (startSec < 0) throw invalid("startSeconds must be 0 or more");
    if (endSec <= startSec) throw invalid("endSeconds must be greater than startSeconds");
    if (endSec > duration + SAME_BOUND_SEC) {
        throw invalid(
            `The ${media.type} video is only ${duration.toFixed(1)} s long; endSeconds ${endSec} is outside it`,
        );
    }
    if (endSec - startSec > env.MAX_SEGMENT_SECONDS) {
        throw invalid(
            `A segment may span at most ${env.MAX_SEGMENT_SECONDS} s (requested ${(endSec - startSec).toFixed(1)} s)`,
        );
    }
    if (!Number.isInteger(count) || count < 1 || count > env.MAX_FRAMES_PER_SEGMENT) {
        throw invalid(`count must be an integer from 1 to ${env.MAX_FRAMES_PER_SEGMENT}`);
    }

    const existing = media.segments.find(
        (s) => Math.abs(s.startSec - startSec) < SAME_BOUND_SEC && Math.abs(s.endSec - endSec) < SAME_BOUND_SEC,
    );
    if (existing) return segmentResult(media, existing.segmentId, true);

    const store = storage();
    if (!(await store.exists(media.storageKey))) {
        throw new ApiError("PROCESSING_ERROR", "Evidence file is missing from storage", [{ retryable: false }]);
    }

    const segmentId = `S${media.segments.length + 1}`;
    const prefix = media.type === "outbound" ? "OUT" : "RET";
    const keyBase = `frames/${safeSegment(media.shopId)}/${safeSegment(media.orderId)}/${media.id}/segments/${segmentId}`;
    const videoPath = store.localPath(media.storageKey);
    const span = endSec - startSec;
    const baseIndex = media.frames.length;
    const frames = [];
    try {
        for (let i = 0; i < count; i++) {
            const timestampSec = Number((startSec + ((i + 0.5) * span) / count).toFixed(3));
            const frameId = `${prefix}-${segmentId}-${String(i + 1).padStart(2, "0")}`;
            const storageKey = `${keyBase}/${frameId}.jpg`;
            const outPath = store.localPath(storageKey);
            await fsp.mkdir(path.dirname(outPath), { recursive: true });
            await extractFrameAt(videoPath, timestampSec, outPath);
            const metrics = await frameMetrics(outPath);
            frames.push({
                frameId,
                index: baseIndex + i,
                timestampSec,
                storageKey,
                brightness: metrics.brightness,
                sharpness: metrics.sharpness,
                quality: classifyFrame(metrics.brightness, metrics.sharpness),
                origin: "segment" as const,
                segmentId,
            });
        }
    } catch (error) {
        for (const frame of frames) await store.delete(frame.storageKey);
        throw error instanceof ApiError ? error : new ApiError("PROCESSING_ERROR", errorMessage(error));
    }

    // Atomic append guarded on the segment ID, so a concurrent request cannot create the same segment twice.
    const update = await MediaEvidence.updateOne(
        { _id: media._id, "segments.segmentId": { $ne: segmentId } },
        {
            $push: {
                frames: { $each: frames },
                segments: {
                    segmentId,
                    startSec,
                    endSec,
                    frameIds: frames.map((f) => f.frameId),
                    inspectionId: request.inspectionId,
                    question: request.question?.slice(0, 500),
                    createdAt: new Date(),
                },
            },
        },
    );
    if (update.modifiedCount !== 1) {
        for (const frame of frames) await store.delete(frame.storageKey);
        throw new ApiError("CONFLICT", "Another segment extraction for this video finished first; retry the request", [
            { retryable: true },
        ]);
    }

    // Read back from the database and storage rather than trusting in-memory state.
    const persisted = await MediaEvidence.findById(media._id);
    if (!persisted?.segments.some((s) => s.segmentId === segmentId)) {
        throw new ApiError("PROCESSING_ERROR", "Segment frames were not persisted");
    }
    const missing = await verifyFramesOnDisk(persisted);
    if (missing.length > 0) throw new ApiError("PROCESSING_ERROR", `Frames missing on disk: ${missing.join(", ")}`);
    return segmentResult(persisted, segmentId, false);
};
