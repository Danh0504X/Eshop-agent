import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { asyncHandler } from "../middleware/asyncHandler";
import { principalOf } from "../middleware/authMiddleware";
import {
    deleteMedia,
    getMediaForPrincipal,
    listOrderMedia,
    serializeMedia,
    uploadEvidence,
} from "../services/mediaService";
import { findOrder } from "../services/orderService";
import { storage } from "../services/storageService";
import { ApiError, notFound } from "../utils/errors";
import { deleteMediaSchema, objectIdParam, uploadMediaFields } from "../validators/schemas";

export const upload: RequestHandler = asyncHandler(async (request, response) => {
    const principal = principalOf(request);
    if (!request.file) throw new ApiError("VALIDATION_ERROR", "Attach a video in the 'file' form field");
    const fields = uploadMediaFields.parse(request.body);
    const order = await findOrder(principal, { orderId: String(request.params.orderId) });
    const media = await uploadEvidence(principal, order, request.file, fields);
    response
        .status(StatusCodes.CREATED)
        .json({ status: "success", message: "Evidence uploaded", data: { media: serializeMedia(media) } });
});

export const listForOrder: RequestHandler = asyncHandler(async (request, response) => {
    const principal = principalOf(request);
    const order = await findOrder(principal, { orderId: String(request.params.orderId) });
    const media = await listOrderMedia(order, request.query.includeInactive === "true");
    response.status(StatusCodes.OK).json({ status: "success", data: { media: media.map(serializeMedia) } });
});

export const streamFile: RequestHandler = asyncHandler(async (request, response) => {
    const media = await getMediaForPrincipal(principalOf(request), objectIdParam.parse(request.params.mediaId));
    if (!(await storage().exists(media.storageKey))) throw notFound("Evidence file");
    response.setHeader("Content-Type", media.mimeType);
    response.setHeader("Content-Disposition", `inline; filename="${media.type}-${media.id}"`);
    storage().createReadStream(media.storageKey).pipe(response);
});

export const streamFrame: RequestHandler = asyncHandler(async (request, response) => {
    const media = await getMediaForPrincipal(principalOf(request), objectIdParam.parse(request.params.mediaId));
    const frame = media.frames.find((f) => f.frameId === request.params.frameId);
    if (!frame || !(await storage().exists(frame.storageKey))) throw notFound("Frame");
    response.setHeader("Content-Type", "image/jpeg");
    storage().createReadStream(frame.storageKey).pipe(response);
});

export const remove: RequestHandler = asyncHandler(async (request, response) => {
    const { reason } = deleteMediaSchema.parse(request.body);
    await deleteMedia(principalOf(request), objectIdParam.parse(request.params.mediaId), reason);
    response.status(StatusCodes.OK).json({ status: "success", message: "Evidence deleted" });
});
