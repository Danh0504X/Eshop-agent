import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const ROLES = ["owner", "employee"] as const;
export type Role = (typeof ROLES)[number];

const UserSchema = new Schema(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        name: { type: String, required: true, trim: true },
        passwordHash: { type: String, required: true, select: false },
        role: { type: String, enum: ROLES, required: true },
        shopId: { type: String, required: true, index: true },
        /** Employees may only act within these warehouses. Owners can access every warehouse of their shop. */
        warehouseIds: { type: [String], default: [] },
        active: { type: Boolean, default: true },
    },
    { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof UserSchema>>;
export const User = model("User", UserSchema);
