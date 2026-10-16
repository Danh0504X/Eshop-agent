import { Order, type OrderDoc } from "../models/Order";
import type { AuthPrincipal } from "../types/auth";
import { ApiError, notFound } from "../utils/errors";
import type { CreateOrderInput } from "../validators/schemas";
import { assertScope, canAccessWarehouse, scopeFilter } from "./accessService";
import { recordAudit } from "./auditService";

export const createOrder = async (principal: AuthPrincipal, input: CreateOrderInput): Promise<OrderDoc> => {
    if (!canAccessWarehouse(principal, input.warehouseId)) {
        throw new ApiError("FORBIDDEN", `Your account is not assigned to warehouse ${input.warehouseId}`);
    }
    const exists = await Order.exists({ shopId: principal.shopId, orderId: input.orderId });
    if (exists) throw new ApiError("CONFLICT", `Order ${input.orderId} already exists`);

    const order = await Order.create({ ...input, shopId: principal.shopId, createdBy: principal.userId });
    await recordAudit({
        action: "order.create",
        actorType: "user",
        actorId: principal.userId,
        shopId: principal.shopId,
        orderId: order.orderId,
    });
    return order;
};

export const listOrders = async (
    principal: AuthPrincipal,
    query: { status?: string; search?: string; limit: number },
): Promise<OrderDoc[]> => {
    const filter: Record<string, unknown> = { ...scopeFilter(principal) };
    if (query.status) filter.inspectionStatus = query.status;
    if (query.search) {
        const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ orderId: new RegExp(escaped, "i") }, { trackingCode: new RegExp(escaped, "i") }];
    }
    return Order.find(filter)
        .sort({ updatedAt: -1 })
        .limit(query.limit)
        .populate("latestInspectionId", "status workflowState summary recommendedAction confidence analysisMode")
        .exec();
};

/**
 * Find one order by order ID or tracking code within the caller's scope.
 * Used by the REST API and by the agent's lookup_order tool.
 */
export const findOrder = async (
    principal: AuthPrincipal,
    ref: { orderId?: string; trackingCode?: string },
): Promise<OrderDoc> => {
    if (!ref.orderId && !ref.trackingCode) {
        throw new ApiError("VALIDATION_ERROR", "Provide orderId or trackingCode");
    }
    const filter: Record<string, unknown> = { shopId: principal.shopId };
    if (ref.orderId) filter.orderId = ref.orderId;
    if (ref.trackingCode) filter.trackingCode = ref.trackingCode;

    const matches = await Order.find(filter).limit(2).exec();
    if (matches.length === 0) throw notFound(`Order ${ref.orderId ?? ref.trackingCode}`);
    if (matches.length > 1) {
        throw new ApiError("CONFLICT", "Tracking code matches more than one order; look up by orderId instead");
    }
    const order = matches[0];
    assertScope(principal, order, "Order");
    return order;
};

/** Public-safe representation of an order. Customer personal data is only returned to owners. */
export const serializeOrder = (order: OrderDoc, principal: AuthPrincipal) => {
    const plain = order.toObject({ versionKey: false });
    if (principal.role !== "owner") delete (plain as { customer?: unknown }).customer;
    return plain;
};
