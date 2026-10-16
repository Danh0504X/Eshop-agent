import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { asyncHandler } from "../middleware/asyncHandler";
import { principalOf } from "../middleware/authMiddleware";
import { recordAudit } from "../services/auditService";
import {
    approveClaim,
    listClaims,
    markClaimSubmitted,
    rejectClaim,
    resolveClaim,
    serializeClaim,
} from "../services/claimReviewService";
import { getClaimForPrincipal, trackRefund } from "../services/claimService";
import { storage } from "../services/storageService";
import { notFound } from "../utils/errors";
import {
    approveClaimSchema,
    listClaimsQuery,
    markSubmittedSchema,
    objectIdParam,
    reasonSchema,
    refundSchema,
} from "../validators/schemas";

const claimId = (params: Record<string, unknown>) => objectIdParam.parse(params.claimId);

export const list: RequestHandler = asyncHandler(async (request, response) => {
    const claims = await listClaims(principalOf(request), listClaimsQuery.parse(request.query));
    response.status(StatusCodes.OK).json({ status: "success", data: { claims: claims.map(serializeClaim) } });
});

export const getOne: RequestHandler = asyncHandler(async (request, response) => {
    const claim = await getClaimForPrincipal(principalOf(request), claimId(request.params));
    response.status(StatusCodes.OK).json({ status: "success", data: { claim: serializeClaim(claim) } });
});

export const downloadReport: RequestHandler = asyncHandler(async (request, response) => {
    const principal = principalOf(request);
    const claim = await getClaimForPrincipal(principal, claimId(request.params));
    if (!claim.reportStorageKey || !(await storage().exists(claim.reportStorageKey))) throw notFound("Claim report");
    // Exports leave the system, so they are audited.
    await recordAudit({
        action: "claim.report_download",
        actorType: "user",
        actorId: principal.userId,
        shopId: claim.shopId,
        orderId: claim.orderId,
        claimId: claim.id,
    });
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="claim-${claim.orderId}-${claim.id}.pdf"`);
    storage().createReadStream(claim.reportStorageKey).pipe(response);
});

export const approve: RequestHandler = asyncHandler(async (request, response) => {
    const claim = await approveClaim(
        principalOf(request),
        claimId(request.params),
        approveClaimSchema.parse(request.body),
    );
    response
        .status(StatusCodes.OK)
        .json({ status: "success", message: "Claim approved", data: { claim: serializeClaim(claim) } });
});

export const reject: RequestHandler = asyncHandler(async (request, response) => {
    const claim = await rejectClaim(principalOf(request), claimId(request.params), reasonSchema.parse(request.body));
    response
        .status(StatusCodes.OK)
        .json({ status: "success", message: "Claim rejected", data: { claim: serializeClaim(claim) } });
});

export const markSubmitted: RequestHandler = asyncHandler(async (request, response) => {
    const claim = await markClaimSubmitted(
        principalOf(request),
        claimId(request.params),
        markSubmittedSchema.parse(request.body),
    );
    response.status(StatusCodes.OK).json({
        status: "success",
        message: "Submission recorded. FixIt did not submit anything externally.",
        data: { claim: serializeClaim(claim) },
    });
});

export const resolve: RequestHandler = asyncHandler(async (request, response) => {
    const claim = await resolveClaim(principalOf(request), claimId(request.params), reasonSchema.parse(request.body));
    response
        .status(StatusCodes.OK)
        .json({ status: "success", message: "Claim resolved", data: { claim: serializeClaim(claim) } });
});

export const refund: RequestHandler = asyncHandler(async (request, response) => {
    const id = claimId(request.params);
    const claim = await trackRefund(principalOf(request), id, refundSchema.parse(request.body));
    response.status(StatusCodes.OK).json({
        status: "success",
        message: claim.refund?.flagged
            ? "Refund recorded. The actual refund is lower than the requested compensation."
            : "Refund recorded.",
        data: { claim: serializeClaim(claim) },
    });
});
