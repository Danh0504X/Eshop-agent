import { Claim, FINAL_DETERMINATIONS, type ClaimDoc, type ClaimStatus } from "../models/Claim";
import { Inspection } from "../models/Inspection";
import { Order } from "../models/Order";
import type { AuthPrincipal } from "../types/auth";
import { ApiError } from "../utils/errors";
import { assertRole, scopeFilter } from "./accessService";
import { recordAudit } from "./auditService";
import { getClaimForPrincipal } from "./claimService";

/**
 * Human review of AI-drafted claims. Every consequential transition is owner-only, needs a recorded
 * reason, and is audited. Nothing here contacts customers, couriers or external claim platforms.
 */

const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
    draft: ["pending_approval", "rejected"],
    pending_approval: ["approved", "rejected"],
    approved: ["submitted", "resolved"],
    submitted: ["resolved"],
    rejected: [],
    resolved: [],
};

export type FinalDetermination = (typeof FINAL_DETERMINATIONS)[number];

const assertTransition = (claim: ClaimDoc, to: ClaimStatus) => {
    if (!TRANSITIONS[claim.status].includes(to)) {
        throw new ApiError("INVALID_STATE", `Claim is ${claim.status}; it cannot move to ${to}`);
    }
};

const changeStatus = async (
    principal: AuthPrincipal,
    claim: ClaimDoc,
    to: ClaimStatus,
    reason: string,
    action: string,
    details: Record<string, unknown> = {},
) => {
    const from = claim.status;
    claim.status = to;
    claim.history.push({ by: principal.userId, from, to, reason });
    await claim.save();
    await recordAudit({
        action,
        actorType: "user",
        actorId: principal.userId,
        shopId: claim.shopId,
        orderId: claim.orderId,
        inspectionId: claim.inspectionId.toString(),
        claimId: claim.id,
        details: { from, to, reason, ...details },
    });
};

/**
 * Deciding the claim is the human review for advisory escalations (e.g. instruction-like text in the footage),
 * so an open non-blocking review task on the inspection is resolved with the decision.
 */
const resolveAdvisoryReview = async (principal: AuthPrincipal, claim: ClaimDoc, note: string) => {
    const inspection = await Inspection.findById(claim.inspectionId);
    if (!inspection || inspection.reviewTask?.status !== "open" || inspection.escalation?.blocking) return;
    inspection.set("reviewTask.status", "resolved");
    inspection.set("reviewTask.resolvedAt", new Date());
    inspection.set("reviewTask.resolvedBy", principal.userId);
    inspection.set("reviewTask.resolutionNote", note);
    inspection.status = "completed";
    inspection.workflowState = "COMPLETED";
    inspection.stateHistory.push({ state: "COMPLETED", at: new Date(), note, attempt: inspection.attempt });
    await inspection.save();
    await Order.updateOne({ _id: inspection.orderRef }, { $set: { inspectionStatus: "completed" } });
};

export const approveClaim = async (
    principal: AuthPrincipal,
    claimId: string,
    input: { reason: string; finalDetermination?: FinalDetermination },
): Promise<ClaimDoc> => {
    assertRole(principal, ["owner"], "approve claims");
    const claim = await getClaimForPrincipal(principal, claimId);
    assertTransition(claim, "approved");
    const finalDetermination = input.finalDetermination ?? "no_determination";
    claim.set("approval", {
        decision: "approved",
        decidedBy: principal.userId,
        decidedAt: new Date(),
        reason: input.reason,
        finalDetermination,
    });
    await changeStatus(principal, claim, "approved", input.reason, "claim.approve", { finalDetermination });
    await resolveAdvisoryReview(principal, claim, `Claim approved by reviewer: ${input.reason}`);
    return claim;
};

export const rejectClaim = async (principal: AuthPrincipal, claimId: string, input: { reason: string }) => {
    assertRole(principal, ["owner"], "reject claims");
    const claim = await getClaimForPrincipal(principal, claimId);
    assertTransition(claim, "rejected");
    claim.set("approval", {
        decision: "rejected",
        decidedBy: principal.userId,
        decidedAt: new Date(),
        reason: input.reason,
        finalDetermination: "no_determination",
    });
    await changeStatus(principal, claim, "rejected", input.reason, "claim.reject");
    await resolveAdvisoryReview(principal, claim, `Claim rejected by reviewer: ${input.reason}`);
    return claim;
};

/** Records that a person submitted the approved claim elsewhere. The system itself submits nothing. */
export const markClaimSubmitted = async (
    principal: AuthPrincipal,
    claimId: string,
    input: { externalReference?: string; note?: string },
) => {
    assertRole(principal, ["owner"], "record claim submission");
    const claim = await getClaimForPrincipal(principal, claimId);
    assertTransition(claim, "submitted");
    const reason = [
        "Submitted manually by a reviewer outside FixIt (no automatic external submission)",
        input.externalReference ? `reference ${input.externalReference}` : null,
        input.note,
    ]
        .filter(Boolean)
        .join("; ");
    await changeStatus(principal, claim, "submitted", reason, "claim.mark_submitted", {
        externalReference: input.externalReference,
    });
    return claim;
};

export const resolveClaim = async (principal: AuthPrincipal, claimId: string, input: { reason: string }) => {
    assertRole(principal, ["owner"], "resolve claims");
    const claim = await getClaimForPrincipal(principal, claimId);
    assertTransition(claim, "resolved");
    await changeStatus(principal, claim, "resolved", input.reason, "claim.resolve");
    return claim;
};

export const listClaims = async (
    principal: AuthPrincipal,
    query: { status?: ClaimStatus; orderId?: string; limit: number },
) => {
    const filter: Record<string, unknown> = { ...scopeFilter(principal) };
    if (query.status) filter.status = query.status;
    if (query.orderId) filter.orderId = query.orderId;
    return Claim.find(filter).sort({ updatedAt: -1 }).limit(query.limit).exec();
};

export const serializeClaim = (claim: ClaimDoc) => {
    const { reportStorageKey, ...rest } = claim.toObject({ versionKey: false });
    return {
        ...rest,
        reportUrl: reportStorageKey ? `/api/claims/${claim.id}/report` : null,
        externalSubmission: "not_supported",
    };
};
