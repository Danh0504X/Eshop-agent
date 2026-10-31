import crypto from "node:crypto";
import { Order, type OrderDoc } from "../models/Order";
import type { ScanMethod } from "../models/ScanSession";
import type { AuthPrincipal } from "../types/auth";
import { ApiError, notFound } from "../utils/errors";
import type { CreateOrderInput } from "../validators/schemas";
import { assertScope, canAccessWarehouse, scopeFilter } from "./accessService";
import { recordAudit } from "./auditService";

/** No 0/O or 1/I/L, so a generated ID can be read aloud or retyped without mistakes. */
const ORDER_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ORDER_ID_ATTEMPTS = 5;

/** ORD-YYMMDD-XXXX: the server's local date plus four unambiguous random characters. */
export const generateOrderId = (now = new Date(), randomInt: (max: number) => number = crypto.randomInt): string => {
    const day = [now.getFullYear() % 100, now.getMonth() + 1, now.getDate()]
        .map((n) => String(n).padStart(2, "0"))
        .join("");
    const suffix = Array.from({ length: 4 }, () => ORDER_ID_ALPHABET[randomInt(ORDER_ID_ALPHABET.length)]).join("");
    return `ORD-${day}-${suffix}`;
};

const isDuplicateKey = (error: unknown) => (error as { code?: number }).code === 11000;

export interface NewOrder extends Omit<CreateOrderInput, "scanId"> {
    trackingCode: string;
    trackingScan: { scanId: string; method: ScanMethod; manualEntry: boolean; scannedAt: Date; scannedBy: string };
}

/**
 * Create an order with a generated order ID. Called by the scan workflow, which supplies the scanned tracking
 * code; a tracking code can belong to only one order in a shop.
 */
export const createOrder = async (principal: AuthPrincipal, input: NewOrder): Promise<OrderDoc> => {
    if (!canAccessWarehouse(principal, input.warehouseId)) {
        throw new ApiError("FORBIDDEN", `Your account is not assigned to warehouse ${input.warehouseId}`);
    }
    const taken = await Order.exists({ shopId: principal.shopId, trackingCode: input.trackingCode });
    if (taken) throw new ApiError("CONFLICT", `Tracking code ${input.trackingCode} already belongs to an order`);

    let order: OrderDoc | undefined;
    for (let attempt = 1; !order; attempt++) {
        try {
            order = await Order.create({
                ...input,
                orderId: generateOrderId(),
                shopId: principal.shopId,
                createdBy: principal.userId,
            });
        } catch (error) {
            // The unique (shopId, orderId) index rejects the rare collision; draw a new ID.
            if (!isDuplicateKey(error) || attempt >= ORDER_ID_ATTEMPTS) throw error;
        }
    }
    await recordAudit({
        action: "order.create",
        actorType: "user",
        actorId: principal.userId,
        shopId: principal.shopId,
        orderId: order.orderId,
        details: { trackingCode: order.trackingCode, scanMethod: input.trackingScan.method },
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
