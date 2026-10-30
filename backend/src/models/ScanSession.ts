import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const SCAN_PURPOSES = ["packing", "return"] as const;
export type ScanPurpose = (typeof SCAN_PURPOSES)[number];

/** How the code reached the app. "manual" means a person typed it because the label could not be scanned. */
export const SCAN_METHODS = ["camera", "image_file", "hand_scanner", "manual"] as const;
export type ScanMethod = (typeof SCAN_METHODS)[number];

/**
 * One scan of a shipping label, timestamped by the server. It is what binds the next steps (creating the
 * order, uploading its video) to the tracking code that was physically scanned, instead of the AI reading
 * the code from the footage. A scan expires and each of its uses is recorded once.
 */
const ScanSessionSchema = new Schema(
    {
        shopId: { type: String, required: true, index: true },
        scannedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        code: { type: String, required: true, trim: true },
        purpose: { type: String, enum: SCAN_PURPOSES, required: true },
        method: { type: String, enum: SCAN_METHODS, required: true },
        /** The order the code belongs to: found at scan time, or (packing) created from this scan. */
        orderRef: { type: Schema.Types.ObjectId, ref: "Order" },
        orderId: { type: String },
        expiresAt: { type: Date, required: true },
        /** Packing scans only: set once, when an order is created from this scan. */
        orderCreatedAt: { type: Date },
        /** Set once, when an evidence video is uploaded with this scan. */
        mediaLinkedAt: { type: Date },
        mediaRef: { type: Schema.Types.ObjectId, ref: "MediaEvidence" },
    },
    { timestamps: true },
);

export type ScanSessionAttrs = InferSchemaType<typeof ScanSessionSchema>;
export type ScanSessionDoc = HydratedDocument<ScanSessionAttrs>;
export const ScanSession = model("ScanSession", ScanSessionSchema);
