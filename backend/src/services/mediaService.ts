import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { MediaEvidence, type CaptureMethod, type MediaDoc, type MediaType } from "../models/MediaEvidence";
import { Order, type OrderDoc } from "../models/Order";
import type { AuthPrincipal } from "../types/auth";
import { ApiError, notFound } from "../utils/errors";
import { assertRole, assertScope } from "./accessService";
import { recordAudit } from "./auditService";
// import { probeVideo } from "./ffmpegService"; // used by the recording-time check below (disabled for now)
import { bindScanToEvidence, claimScanForEvidence, releaseScanForEvidence, usableScan } from "./scanService";
import { safeSegment, storage } from "./storageService";

export const ALLOWED_VIDEO_TYPES: Record<string, string[]> = {
    "video/mp4": [".mp4", ".m4v"],
    "video/quicktime": [".mov"],
    "video/webm": [".webm"],
    "video/x-matroska": [".mkv"],
    "video/x-msvideo": [".avi"],
};

/** Inspect magic bytes so a renamed non-video file cannot pass on extension/MIME alone. */
export const sniffVideoContainer = (head: Buffer): string | null => {
    if (head.length >= 12 && head.subarray(4, 8).toString("ascii") === "ftyp") return "iso-bmff"; // mp4 / mov / m4v
    if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "ebml"; // webm / mkv
    if (
        head.length >= 12 &&
        head.subarray(0, 4).toString("ascii") === "RIFF" &&
        head.subarray(8, 11).toString("ascii") === "AVI"
    )
        return "avi";
    return null;
};

const activeMediaIds = (order: OrderDoc, type: MediaType): Types.ObjectId[] =>
    (type === "outbound" ? order.packingMedia : order.returnMedia) as Types.ObjectId[];

export interface UploadedFile {
    path: string;
    originalname: string;
    mimetype: string;
    size: number;
}

export interface UploadOptions {
    type: MediaType;
    /** A scan of this order's label by the uploader: packing scan for outbound, return scan for return videos. */
    scanId: string;
    captureMethod: CaptureMethod;
    recordingStartedAt?: Date;
    recordingEndedAt?: Date;
    replaceExisting: boolean;
    replacementReason?: string;
}

// Disabled together with the recording-time check in uploadEvidence:
// /** Clock and encoding slack allowed when a recorded video is compared with the time since its scan. */
// const RECORDING_SLACK_SEC = 5;

/**
 * Store an uploaded evidence video and link it to the order. The video must come with an unused scan of the
 * order's label. The temp file is always removed, whether the upload succeeds or not.
 */
export const uploadEvidence = async (
    principal: AuthPrincipal,
    order: OrderDoc,
    file: UploadedFile,
    options: UploadOptions,
): Promise<MediaDoc> => {
    try {
        const extension = path.extname(file.originalname).toLowerCase();
        const allowedExtensions = ALLOWED_VIDEO_TYPES[file.mimetype];
        if (!allowedExtensions || !allowedExtensions.includes(extension)) {
            throw new ApiError(
                "UNSUPPORTED_MEDIA_TYPE",
                `Unsupported video type ${file.mimetype} (${extension || "no extension"})`,
            );
        }
        const handle = await fsp.open(file.path, "r");
        const head = Buffer.alloc(16);
        try {
            await handle.read(head, 0, 16, 0);
        } finally {
            await handle.close();
        }
        if (!sniffVideoContainer(head)) {
            throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "File content is not a recognised video container");
        }

        // Fail fast before writing anything if this would silently replace existing evidence.
        if (activeMediaIds(order, options.type).length > 0 && !options.replaceExisting) {
            throw new ApiError(
                "CONFLICT",
                `Order ${order.orderId} already has ${options.type} evidence. Set replaceExisting=true with a replacementReason to replace it.`,
            );
        }

        const scan = await usableScan(principal, options.scanId, options.type === "outbound" ? "packing" : "return");
        if (scan.code !== order.trackingCode) {
            throw new ApiError(
                "VALIDATION_ERROR",
                `The scanned label (${scan.code}) is not the tracking code of order ${order.orderId}`,
            );
        }
        if (options.captureMethod === "file" && !env.ALLOW_FILE_EVIDENCE) {
            throw new ApiError(
                "FORBIDDEN",
                "Attaching video files is disabled; record the video in the app after scanning the label",
            );
        }
        // TEMPORARILY DISABLED: a video recorded after the scan cannot be longer than the time since that scan.
        // Turned off so videos recorded earlier can still be uploaded while the workflow is being tried out.
        // To re-enable: uncomment this block, the probeVideo import and RECORDING_SLACK_SEC above; in
        // tests/evidenceCapture.test.ts un-skip "refuses a recorded video longer than the time since its scan" and
        // delete "... while the recording-time check is disabled".
        // if (options.captureMethod === "recorded") {
        //     const { durationSec } = await probeVideo(file.path);
        //     const sinceScanSec = (Date.now() - scan.createdAt.getTime()) / 1000;
        //     if (durationSec > sinceScanSec + RECORDING_SLACK_SEC) {
        //         throw new ApiError(
        //             "VALIDATION_ERROR",
        //             `The video is ${durationSec.toFixed(1)} s long but the label was scanned ${sinceScanSec.toFixed(0)} s ago; record the video after scanning the label`,
        //         );
        //     }
        // }

        await claimScanForEvidence(scan);
        try {
            const sha256 = crypto
                .createHash("sha256")
                .update(await fsp.readFile(file.path))
                .digest("hex");
            const key = `media/${safeSegment(order.shopId)}/${safeSegment(order.orderId)}/${options.type}-${crypto.randomUUID()}${extension}`;
            await storage().importFile(file.path, key);

            const media = await MediaEvidence.create({
                orderId: order.orderId,
                orderRef: order._id,
                shopId: order.shopId,
                warehouseId: order.warehouseId,
                type: options.type,
                storageKey: key,
                originalName: path.basename(file.originalname).slice(0, 200),
                mimeType: file.mimetype,
                sizeBytes: file.size,
                sha256,
                uploadedBy: principal.userId,
                capture: {
                    scanId: scan._id,
                    scanMethod: scan.method,
                    manualEntry: scan.method === "manual",
                    scannedAt: scan.createdAt,
                    scannedBy: scan.scannedBy,
                    captureMethod: options.captureMethod,
                    recordingStartedAt: options.recordingStartedAt,
                    recordingEndedAt: options.recordingEndedAt,
                },
            });
            await recordAudit({
                action: "media.upload",
                actorType: "user",
                actorId: principal.userId,
                shopId: order.shopId,
                orderId: order.orderId,
                mediaId: media.id,
                details: {
                    type: options.type,
                    sizeBytes: file.size,
                    sha256,
                    captureMethod: options.captureMethod,
                    scanMethod: scan.method,
                },
            });

            const linked = await linkMedia(
                principal,
                { orderId: order.orderId, mediaId: media.id, type: options.type },
                {
                    actorType: "user",
                    replaceExisting: options.replaceExisting,
                    replacementReason: options.replacementReason,
                },
            );
            await bindScanToEvidence(scan, linked._id);
            return linked;
        } catch (error) {
            // The scan is released so the person can retry with it.
            await releaseScanForEvidence(scan);
            throw error;
        }
    } finally {
        await fsp.rm(file.path, { force: true });
    }
};

/**
 * Attach a stored evidence file to an order. Shared by the upload endpoint and the agent's link_media tool.
 * Never overwrites existing evidence: replacing requires an explicit, human-initiated replaceExisting + reason.
 */
export const linkMedia = async (
    principal: AuthPrincipal,
    args: { orderId: string; mediaId: string; type: MediaType },
    options: { actorType: "user" | "agent"; replaceExisting?: boolean; replacementReason?: string },
): Promise<MediaDoc> => {
    const order = await Order.findOne({ shopId: principal.shopId, orderId: args.orderId });
    if (!order) throw notFound(`Order ${args.orderId}`);
    assertScope(principal, order, "Order");

    const media = await MediaEvidence.findById(args.mediaId);
    if (!media || media.status === "deleted") throw notFound("Media evidence");
    assertScope(principal, media, "Media evidence");
    if (media.orderId !== order.orderId || media.shopId !== order.shopId) {
        throw new ApiError(
            "VALIDATION_ERROR",
            `Media ${media.id} was uploaded for order ${media.orderId}, not ${order.orderId}`,
        );
    }
    if (media.type !== args.type) {
        throw new ApiError("VALIDATION_ERROR", `Media ${media.id} is ${media.type} evidence, not ${args.type}`);
    }
    if (!ALLOWED_VIDEO_TYPES[media.mimeType]) {
        throw new ApiError("UNSUPPORTED_MEDIA_TYPE", `Media ${media.id} has unsupported type ${media.mimeType}`);
    }
    if (media.status === "superseded") {
        throw new ApiError("INVALID_STATE", `Media ${media.id} has been superseded and cannot be re-linked`);
    }

    const current = activeMediaIds(order, args.type);
    if (current.some((id) => id.equals(media._id))) return media; // already linked: idempotent

    if (current.length > 0) {
        // Replacement is a consequential action: only a human request with a recorded reason may do it.
        if (options.actorType !== "user" || !options.replaceExisting || !options.replacementReason) {
            throw new ApiError(
                "APPROVAL_REQUIRED",
                `Order ${order.orderId} already has ${args.type} evidence; replacing it requires explicit human approval with a reason.`,
            );
        }
        await MediaEvidence.updateMany(
            { _id: { $in: current } },
            { $set: { status: "superseded", supersededBy: media._id, replacementReason: options.replacementReason } },
        );
        await recordAudit({
            action: "media.replace",
            actorType: "user",
            actorId: principal.userId,
            shopId: order.shopId,
            orderId: order.orderId,
            mediaId: media.id,
            details: { type: args.type, replaced: current.map(String), reason: options.replacementReason },
        });
    }

    const field = args.type === "outbound" ? "packingMedia" : "returnMedia";
    await Order.updateOne({ _id: order._id }, { $set: { [field]: [media._id] } });
    media.status = media.frames.length > 0 ? "processed" : "linked";
    await media.save();

    // Read back: confirm the link actually persisted before reporting success.
    const verify = await Order.findById(order._id).select(field).lean();
    const linked = (verify?.[field] as Types.ObjectId[] | undefined)?.some((id) => id.equals(media._id));
    if (!linked) throw new ApiError("INTERNAL_ERROR", "Media link did not persist");

    await recordAudit({
        action: "media.link",
        actorType: options.actorType,
        actorId: principal.userId,
        shopId: order.shopId,
        orderId: order.orderId,
        mediaId: media.id,
        details: { type: args.type },
    });
    return media;
};

export const listOrderMedia = async (order: OrderDoc, includeInactive = false): Promise<MediaDoc[]> => {
    const filter: Record<string, unknown> = { shopId: order.shopId, orderId: order.orderId };
    if (!includeInactive) filter.status = { $nin: ["superseded", "deleted"] };
    return MediaEvidence.find(filter).sort({ uploadedAt: -1 }).exec();
};

export const getMediaForPrincipal = async (principal: AuthPrincipal, mediaId: string): Promise<MediaDoc> => {
    const media = await MediaEvidence.findById(mediaId);
    if (!media || media.status === "deleted") throw notFound("Media evidence");
    assertScope(principal, media, "Media evidence");
    return media;
};

/** Deleting evidence is owner-only, needs an explicit confirmation and a reason, and is audited. */
export const deleteMedia = async (principal: AuthPrincipal, mediaId: string, reason: string): Promise<void> => {
    assertRole(principal, ["owner"], "delete evidence");
    const media = await getMediaForPrincipal(principal, mediaId);
    await storage().delete(media.storageKey);
    for (const frame of media.frames) await storage().delete(frame.storageKey);
    media.status = "deleted";
    media.deletedAt = new Date();
    await media.save();
    await Order.updateOne({ _id: media.orderRef }, { $pull: { packingMedia: media._id, returnMedia: media._id } });
    await recordAudit({
        action: "media.delete",
        actorType: "user",
        actorId: principal.userId,
        shopId: media.shopId,
        orderId: media.orderId,
        mediaId: media.id,
        details: { reason },
    });
};

export const serializeMedia = (media: MediaDoc) => {
    const { storageKey: _storageKey, analysisCache: _analysisCache, ...rest } = media.toObject({ versionKey: false });
    return {
        ...rest,
        frames: (rest.frames ?? []).map(({ storageKey: _key, ...frame }) => frame),
        fileUrl: `/api/media/${media.id}/file`,
    };
};
