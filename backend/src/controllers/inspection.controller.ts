import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { asyncHandler } from "../middleware/asyncHandler";
import { principalOf } from "../middleware/authMiddleware";
import {
    getInspectionForPrincipal,
    listOrderInspections,
    retryInspection,
    serializeInspection,
    startInspection,
} from "../services/inspectionService";
import { objectIdParam } from "../validators/schemas";

export const start: RequestHandler = asyncHandler(async (request, response) => {
    const inspection = await startInspection(principalOf(request), String(request.params.orderId));
    response
        .status(StatusCodes.ACCEPTED)
        .location(`/api/inspections/${inspection.id}`)
        .json({
            status: "success",
            message: "Inspection queued. Poll statusUrl for progress.",
            data: { inspection: serializeInspection(inspection) },
        });
});

export const listForOrder: RequestHandler = asyncHandler(async (request, response) => {
    const inspections = await listOrderInspections(principalOf(request), String(request.params.orderId));
    response.status(StatusCodes.OK).json({ status: "success", data: { inspections } });
});

export const getOne: RequestHandler = asyncHandler(async (request, response) => {
    const inspection = await getInspectionForPrincipal(
        principalOf(request),
        objectIdParam.parse(request.params.inspectionId),
    );
    response.status(StatusCodes.OK).json({ status: "success", data: { inspection: serializeInspection(inspection) } });
});

export const retry: RequestHandler = asyncHandler(async (request, response) => {
    const inspection = await retryInspection(principalOf(request), objectIdParam.parse(request.params.inspectionId));
    response
        .status(StatusCodes.ACCEPTED)
        .location(`/api/inspections/${inspection.id}`)
        .json({
            status: "success",
            message: "Inspection retry queued",
            data: { inspection: serializeInspection(inspection) },
        });
});
