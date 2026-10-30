import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const INSPECTION_STATUSES = ["none", "pending", "processing", "needs_review", "completed", "failed"] as const;

const OrderSchema = new Schema(
    {
        orderId: { type: String, required: true, trim: true },
        trackingCode: { type: String, required: true, trim: true },
        shopId: { type: String, required: true, index: true },
        warehouseId: { type: String, required: true, index: true },
        product: {
            name: { type: String, required: true },
            description: { type: String, default: "" },
            sku: { type: String },
            model: { type: String },
            color: { type: String },
        },
        expectedQuantity: { type: Number, required: true, min: 1 },
        expectedAccessories: { type: [String], default: [] },
        /** Personal data: never sent to the AI provider, redacted in exported reports. */
        customer: {
            name: { type: String },
            phone: { type: String },
            address: { type: String },
        },
        packingMedia: [{ type: Schema.Types.ObjectId, ref: "MediaEvidence" }],
        returnMedia: [{ type: Schema.Types.ObjectId, ref: "MediaEvidence" }],
        inspectionStatus: { type: String, enum: INSPECTION_STATUSES, default: "none" },
        latestInspectionId: { type: Schema.Types.ObjectId, ref: "Inspection" },
        latestClaimId: { type: Schema.Types.ObjectId, ref: "Claim" },
        /** Development-only: selects predefined demo analysis results when DEMO_MODE is on. */
        demoScenario: { type: String },
        createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
    { timestamps: true },
);

OrderSchema.index({ shopId: 1, orderId: 1 }, { unique: true });
OrderSchema.index({ shopId: 1, trackingCode: 1 });

export type OrderAttrs = InferSchemaType<typeof OrderSchema>;
export type OrderDoc = HydratedDocument<OrderAttrs>;
export const Order = model("Order", OrderSchema);
