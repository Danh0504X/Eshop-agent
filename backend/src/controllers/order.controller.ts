import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { asyncHandler } from "../middleware/asyncHandler";
import { principalOf } from "../middleware/authMiddleware";
import { findOrder, listOrders, serializeOrder } from "../services/orderService";
import { createOrderFromScan } from "../services/scanService";
import { createOrderSchema, listOrdersQuery } from "../validators/schemas";

export const create: RequestHandler = asyncHandler(async (request, response) => {
    const principal = principalOf(request);
    const order = await createOrderFromScan(principal, createOrderSchema.parse(request.body));
    response
        .status(StatusCodes.CREATED)
        .json({ status: "success", message: "Order created", data: { order: serializeOrder(order, principal) } });
});

export const list: RequestHandler = asyncHandler(async (request, response) => {
    const principal = principalOf(request);
    const orders = await listOrders(principal, listOrdersQuery.parse(request.query));
    response.status(StatusCodes.OK).json({
        status: "success",
        data: { orders: orders.map((order) => serializeOrder(order, principal)) },
    });
});

export const getOne: RequestHandler = asyncHandler(async (request, response) => {
    const principal = principalOf(request);
    const order = await findOrder(principal, { orderId: String(request.params.orderId) });
    await order.populate("latestInspectionId");
    response.status(StatusCodes.OK).json({ status: "success", data: { order: serializeOrder(order, principal) } });
});
