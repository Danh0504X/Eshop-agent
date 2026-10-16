import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const CLAIM_STATUSES = ["draft", "pending_approval", "approved", "submitted", "rejected", "resolved"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Only a human reviewer can record one of these; the agent never sets it. */
export const FINAL_DETERMINATIONS = [
    "no_determination",
    "discrepancy_confirmed_by_reviewer",
    "no_discrepancy",
    "inconclusive",
] as const;

const ClaimSchema = new Schema(
    {
        orderId: { type: String, required: true, index: true },
        orderRef: { type: Schema.Types.ObjectId, ref: "Order", required: true },
        inspectionId: { type: Schema.Types.ObjectId, ref: "Inspection", required: true },
        shopId: { type: String, required: true, index: true },
        warehouseId: { type: String, required: true },
        summary: { type: String, required: true },
        findings: { type: Schema.Types.Mixed, default: [] },
        evidenceReferences: [
            { _id: false, frameId: String, mediaId: String, type: { type: String }, timestampSec: Number },
        ],
        uncertaintyNotes: { type: [String], default: [] },
        aiGenerated: { type: Boolean, default: true },
        analysisMode: { type: String, enum: ["real", "demo"], required: true },
        reportStorageKey: { type: String },
        reportGeneratedAt: { type: Date },
        redaction: {
            textRedactions: Number,
            framesBlurred: Number,
            framesIncluded: Number,
            fullyAnonymized: { type: Boolean, default: false },
            privacyReviewRequired: { type: Boolean, default: true },
            notes: [String],
        },
        currency: { type: String, default: "USD" },
        requestedCompensation: { type: Number },
        actualRefund: { type: Number },
        refund: {
            discrepancyAmount: Number,
            flagged: Boolean,
            note: String,
            recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
            recordedAt: Date,
            /** Always false in this MVP: there is no authoritative payment integration. */
            paymentVerified: { type: Boolean, default: false },
        },
        status: { type: String, enum: CLAIM_STATUSES, default: "draft" },
        approval: {
            decision: { type: String, enum: ["approved", "rejected"] },
            decidedBy: { type: Schema.Types.ObjectId, ref: "User" },
            decidedAt: Date,
            reason: String,
            finalDetermination: { type: String, enum: FINAL_DETERMINATIONS },
        },
        history: [
            {
                _id: false,
                at: { type: Date, default: Date.now },
                by: String,
                from: String,
                to: String,
                reason: String,
            },
        ],
    },
    { timestamps: true },
);

export type ClaimAttrs = InferSchemaType<typeof ClaimSchema>;
export type ClaimDoc = HydratedDocument<ClaimAttrs>;
export const Claim = model("Claim", ClaimSchema);
