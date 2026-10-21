import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const MEDIA_TYPES = ["outbound", "return"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const MEDIA_STATUSES = [
    "uploaded",
    "linked",
    "processing",
    "processed",
    "failed",
    "superseded",
    "deleted",
] as const;

const FrameSchema = new Schema(
    {
        frameId: { type: String, required: true },
        index: { type: Number, required: true },
        timestampSec: { type: Number, required: true },
        storageKey: { type: String, required: true },
        brightness: { type: Number },
        sharpness: { type: Number },
        quality: { type: String, enum: ["ok", "dark", "blurry", "dark_and_blurry"], default: "ok" },
        /** "initial" = the evenly sampled baseline set; "segment" = added later for a targeted re-inspection. */
        origin: { type: String, enum: ["initial", "segment"], default: "initial" },
        segmentId: { type: String },
    },
    { _id: false },
);

/** Provenance of a targeted extraction. Segment frames are append-only and never replace baseline frames. */
const SegmentSchema = new Schema(
    {
        segmentId: { type: String, required: true },
        startSec: { type: Number, required: true },
        endSec: { type: Number, required: true },
        frameIds: { type: [String], default: [] },
        inspectionId: { type: String },
        question: { type: String },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: false },
);

const MediaEvidenceSchema = new Schema(
    {
        orderId: { type: String, required: true, index: true },
        orderRef: { type: Schema.Types.ObjectId, ref: "Order", index: true },
        shopId: { type: String, required: true, index: true },
        warehouseId: { type: String, required: true },
        type: { type: String, enum: MEDIA_TYPES, required: true },
        storageKey: { type: String, required: true },
        originalName: { type: String, default: "" },
        mimeType: { type: String, required: true },
        sizeBytes: { type: Number, required: true },
        sha256: { type: String, required: true },
        uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        uploadedAt: { type: Date, default: Date.now },
        status: { type: String, enum: MEDIA_STATUSES, default: "uploaded" },
        metadata: {
            durationSec: Number,
            width: Number,
            height: Number,
            codec: String,
            fps: Number,
            probedAt: Date,
        },
        frames: { type: [FrameSchema], default: [] },
        segments: { type: [SegmentSchema], default: [] },
        quality: {
            darkFrameRatio: Number,
            blurryFrameRatio: Number,
            maxTimestampGapSec: Number,
            continuous: Boolean,
            assessedAt: Date,
        },
        extractionAttempts: { type: Number, default: 0 },
        processingError: { type: String },
        supersededBy: { type: Schema.Types.ObjectId, ref: "MediaEvidence" },
        replacementReason: { type: String },
        deletedAt: { type: Date },
    },
    { timestamps: true },
);

export type MediaAttrs = InferSchemaType<typeof MediaEvidenceSchema>;
export type MediaDoc = HydratedDocument<MediaAttrs>;
export const MediaEvidence = model("MediaEvidence", MediaEvidenceSchema);
