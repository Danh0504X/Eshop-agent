import { z } from "zod";
import { CLAIM_STATUSES, FINAL_DETERMINATIONS } from "../models/Claim";
import { MEDIA_TYPES } from "../models/MediaEvidence";

const identifier = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, "Only letters, digits, '.', '_' and '-' are allowed");

export const loginSchema = z.object({
    email: z.email(),
    password: z.string().min(1).max(200),
});

export const createOrderSchema = z.object({
    orderId: identifier,
    trackingCode: identifier,
    warehouseId: identifier,
    product: z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        sku: z.string().max(100).optional(),
        model: z.string().max(100).optional(),
        color: z.string().max(60).optional(),
    }),
    expectedQuantity: z.number().int().min(1).max(10_000),
    expectedAccessories: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    declaredValue: z.number().min(0).max(10_000_000),
    currency: z.string().length(3).toUpperCase().default("USD"),
    customer: z
        .object({
            name: z.string().max(200).optional(),
            phone: z.string().max(40).optional(),
            address: z.string().max(500).optional(),
        })
        .optional(),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const listOrdersQuery = z.object({
    status: z.enum(["none", "pending", "processing", "needs_review", "completed", "failed"]).optional(),
    search: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

const boolField = z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true");

/** Multipart fields that accompany an evidence upload. */
export const uploadMediaFields = z
    .object({
        type: z.enum(MEDIA_TYPES),
        replaceExisting: boolField,
        replacementReason: z.string().trim().max(500).optional(),
    })
    .refine((v) => !v.replaceExisting || (v.replacementReason && v.replacementReason.length >= 5), {
        message: "replacementReason (at least 5 characters) is required when replacing existing evidence",
        path: ["replacementReason"],
    });

export const deleteMediaSchema = z.object({
    reason: z.string().trim().min(5).max(500),
    confirm: z.literal(true, { error: "Set confirm=true to explicitly approve deleting evidence" }),
});

export const objectIdParam = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");

const reason = z.string().trim().min(5, "Give a reason of at least 5 characters").max(1000);

export const approveClaimSchema = z.object({
    reason,
    finalDetermination: z.enum(FINAL_DETERMINATIONS).optional(),
});

export const reasonSchema = z.object({ reason });

export const markSubmittedSchema = z.object({
    externalReference: z.string().trim().max(200).optional(),
    note: z.string().trim().max(1000).optional(),
});

export const refundSchema = z
    .object({
        requestedCompensation: z.number().min(0).max(10_000_000),
        actualRefund: z.number().min(0).max(10_000_000),
        note: z.string().trim().max(500).optional(),
    })
    .strict();

export const listClaimsQuery = z.object({
    status: z.enum(CLAIM_STATUSES).optional(),
    orderId: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});
