import { z } from "zod";
import { trackRefund } from "../../services/claimService";
import { defineTool } from "./types";

export const trackRefundSchema = z
    .object({
        claimId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid claim id"),
        requestedCompensation: z.number().min(0).max(10_000_000),
        actualRefund: z.number().min(0).max(10_000_000),
        note: z.string().trim().max(500).optional(),
    })
    .strict();

/**
 * Not visible to the planner: amounts must be entered by an authorized user (the refund endpoint
 * runs this tool with that user's principal). It never claims to verify an actual payment.
 */
export const trackRefundTool = defineTool({
    name: "track_refund",
    description:
        "Store the requested compensation and actual refund amounts entered by an authorized user and flag discrepancies.",
    schema: trackRefundSchema,
    plannerVisible: false,
    handler: async (args, ctx) => {
        const claim = await trackRefund(ctx.principal, args.claimId, args);
        return { claimId: claim.id, refund: claim.refund, paymentVerified: false };
    },
});
