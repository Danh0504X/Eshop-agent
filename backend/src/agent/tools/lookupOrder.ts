import { z } from "zod";
import { findOrder } from "../../services/orderService";
import { ApiError } from "../../utils/errors";
import { transition } from "../agentState";
import { defineTool } from "./types";

const schema = z
    .object({
        orderId: z.string().trim().min(1).max(64).optional(),
        trackingCode: z.string().trim().min(1).max(64).optional(),
    })
    .strict()
    .refine((a) => a.orderId || a.trackingCode, { message: "Provide orderId or trackingCode" });

export const lookupOrderTool = defineTool({
    name: "lookup_order",
    description:
        "Find the order being inspected by order ID or tracking code. Enforces the caller's shop and warehouse access. " +
        "Returns product details and which evidence is linked. Customer personal data is never returned.",
    schema,
    plannerVisible: true,
    handler: async (args, ctx) => {
        // Access checks happen inside findOrder with the requesting user's principal.
        const order = await findOrder(ctx.principal, args);
        if (!order._id.equals(ctx.inspection.orderRef)) {
            throw new ApiError(
                "VALIDATION_ERROR",
                `This inspection is for order ${ctx.inspection.orderId}, not ${order.orderId}`,
                [{ retryable: false }],
            );
        }
        ctx.order = order;
        await transition(ctx, "ORDER_LOOKUP", `Order ${order.orderId} found`);
        return {
            orderId: order.orderId,
            trackingCode: order.trackingCode,
            product: {
                name: order.product?.name,
                description: order.product?.description,
                sku: order.product?.sku,
                model: order.product?.model,
                color: order.product?.color,
            },
            expectedQuantity: order.expectedQuantity,
            expectedAccessories: order.expectedAccessories,
            declaredValue: order.declaredValue,
            currency: order.currency,
            outboundEvidenceLinked: order.packingMedia.length > 0,
            returnEvidenceLinked: order.returnMedia.length > 0,
        };
    },
});
