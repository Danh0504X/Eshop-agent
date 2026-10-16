import { Schema, model, type InferSchemaType } from "mongoose";

const AuditLogSchema = new Schema(
    {
        at: { type: Date, default: Date.now, index: true },
        action: { type: String, required: true, index: true },
        actorType: { type: String, enum: ["user", "agent", "system"], required: true },
        actorId: { type: String },
        shopId: { type: String, index: true },
        orderId: { type: String, index: true },
        inspectionId: { type: String },
        claimId: { type: String },
        mediaId: { type: String },
        outcome: { type: String, enum: ["success", "failure", "denied"], default: "success" },
        details: { type: Schema.Types.Mixed },
    },
    { timestamps: false },
);

export type AuditLogAttrs = InferSchemaType<typeof AuditLogSchema>;
export const AuditLog = model("AuditLog", AuditLogSchema);
