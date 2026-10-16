import { z } from "zod";
import { Order, type OrderDoc } from "../../models/Order";
import { ApiError } from "../../utils/errors";
import type { AgentContext } from "../agentState";

export const evidenceTypeSchema = z.enum(["outbound", "return"]);

export const requireOrder = (ctx: AgentContext): OrderDoc => {
    if (!ctx.order) throw new ApiError("INVALID_STATE", "Call lookup_order first");
    return ctx.order;
};

/** Reload the order so tools always act on the persisted state, not a stale copy. */
export const refreshOrder = async (ctx: AgentContext): Promise<OrderDoc> => {
    const order = await Order.findById(requireOrder(ctx)._id);
    if (!order) throw new ApiError("NOT_FOUND", "Order no longer exists");
    ctx.order = order;
    return order;
};
