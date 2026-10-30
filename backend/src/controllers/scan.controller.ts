import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { asyncHandler } from "../middleware/asyncHandler";
import { principalOf } from "../middleware/authMiddleware";
import { serializeOrder } from "../services/orderService";
import { recordScan, serializeScan } from "../services/scanService";
import { createScanSchema } from "../validators/schemas";

export const create: RequestHandler = asyncHandler(async (request, response) => {
    const principal = principalOf(request);
    const { scan, order } = await recordScan(principal, createScanSchema.parse(request.body));
    response.status(StatusCodes.CREATED).json({
        status: "success",
        message: order ? `Order ${order.orderId} found` : "Label scanned; fill in the order details",
        data: { scan: serializeScan(scan), order: order ? serializeOrder(order, principal) : null },
    });
});
