import { env } from "../config/env";
import { Order, type OrderDoc } from "../models/Order";
import { ScanSession, type ScanPurpose, type ScanSessionDoc } from "../models/ScanSession";
import type { AuthPrincipal } from "../types/auth";
import { ApiError, notFound } from "../utils/errors";
import type { CreateOrderInput } from "../validators/schemas";
import { recordAudit } from "./auditService";
import { createOrder, findOrder } from "./orderService";

export interface ScanInput {
    code: string;
    purpose: ScanPurpose;
    method: ScanSessionDoc["method"];
}

/**
 * Record a label scan. A return scan must find the order within the caller's shop and warehouses. A packing
 * scan of a new code is for creating its order; a packing scan of a known code returns that order, so its
 * packing video can be added or replaced (it can never create a second order). The scan then authorises the
 * next step for that code until it expires.
 */
export const recordScan = async (
    principal: AuthPrincipal,
    input: ScanInput,
): Promise<{ scan: ScanSessionDoc; order: OrderDoc | null }> => {
    const known =
        input.purpose === "return" || (await Order.exists({ shopId: principal.shopId, trackingCode: input.code }));
    const order = known ? await findOrder(principal, { trackingCode: input.code }) : null;

    const scan = await ScanSession.create({
        shopId: principal.shopId,
        scannedBy: principal.userId,
        code: input.code,
        purpose: input.purpose,
        method: input.method,
        orderRef: order?._id,
        orderId: order?.orderId,
        expiresAt: new Date(Date.now() + env.SCAN_SESSION_TTL_MINUTES * 60_000),
    });
    await recordAudit({
        action: "scan.record",
        actorType: "user",
        actorId: principal.userId,
        shopId: principal.shopId,
        orderId: order?.orderId,
        details: { purpose: input.purpose, method: input.method, code: input.code },
    });
    return { scan, order };
};

/** A scan the caller may use now: their own, in their shop, made for this purpose and not expired. */
export const usableScan = async (
    principal: AuthPrincipal,
    scanId: string,
    purpose: ScanPurpose,
): Promise<ScanSessionDoc> => {
    const scan = await ScanSession.findById(scanId);
    if (!scan || scan.shopId !== principal.shopId) throw notFound("Scan");
    if (String(scan.scannedBy) !== principal.userId) {
        throw new ApiError("FORBIDDEN", "Only the person who scanned the label can use this scan");
    }
    if (scan.purpose !== purpose) {
        throw new ApiError("INVALID_STATE", `This scan was made for ${scan.purpose}, not ${purpose}`);
    }
    if (scan.expiresAt.getTime() <= Date.now()) {
        throw new ApiError("INVALID_STATE", "This scan has expired; scan the label again");
    }
    return scan;
};

/**
 * Create an order from a packing scan: the tracking code is the scanned one and the order ID is generated.
 * The scan is claimed atomically first, so one scan can never create two orders.
 */
export const createOrderFromScan = async (principal: AuthPrincipal, input: CreateOrderInput): Promise<OrderDoc> => {
    const { scanId, ...fields } = input;
    const scan = await usableScan(principal, scanId, "packing");
    if (scan.orderId) {
        throw new ApiError("CONFLICT", `Tracking code ${scan.code} already belongs to order ${scan.orderId}`, [
            { orderId: scan.orderId },
        ]);
    }
    const claimed = await ScanSession.findOneAndUpdate(
        { _id: scan._id, orderCreatedAt: null },
        { $set: { orderCreatedAt: new Date() } },
        { new: true },
    );
    if (!claimed) throw new ApiError("INVALID_STATE", "An order was already created from this scan");

    let order: OrderDoc;
    try {
        order = await createOrder(principal, {
            ...fields,
            trackingCode: scan.code,
            trackingScan: {
                scanId: scan.id,
                method: scan.method,
                manualEntry: scan.method === "manual",
                scannedAt: scan.createdAt,
                scannedBy: principal.userId,
            },
        });
    } catch (error) {
        // Release the scan so the person can correct the form and try again.
        await ScanSession.updateOne({ _id: scan._id }, { $unset: { orderCreatedAt: 1 } });
        throw error;
    }
    await ScanSession.updateOne({ _id: scan._id }, { $set: { orderRef: order._id, orderId: order.orderId } });
    return order;
};

/** Claim a scan for one evidence upload. Concurrent uploads with the same scan: exactly one wins. */
export const claimScanForEvidence = async (scan: ScanSessionDoc): Promise<void> => {
    const claimed = await ScanSession.findOneAndUpdate(
        { _id: scan._id, mediaLinkedAt: null },
        { $set: { mediaLinkedAt: new Date() } },
    );
    if (!claimed) throw new ApiError("INVALID_STATE", "This scan was already used for a video; scan the label again");
};

/** Undo a claim when the upload fails after it, so the same scan can be used to try again. */
export const releaseScanForEvidence = async (scan: ScanSessionDoc): Promise<void> => {
    await ScanSession.updateOne({ _id: scan._id }, { $unset: { mediaLinkedAt: 1 } });
};

export const bindScanToEvidence = async (scan: ScanSessionDoc, mediaId: unknown): Promise<void> => {
    await ScanSession.updateOne({ _id: scan._id }, { $set: { mediaRef: mediaId } });
};

export const serializeScan = (scan: ScanSessionDoc) => ({
    id: scan.id,
    code: scan.code,
    purpose: scan.purpose,
    method: scan.method,
    manualEntry: scan.method === "manual",
    orderId: scan.orderId ?? null,
    scannedAt: scan.createdAt,
    expiresAt: scan.expiresAt,
});
