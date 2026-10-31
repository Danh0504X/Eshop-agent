import { env } from "../config/env";
import { Claim } from "../models/Claim";
import { Inspection, type InspectionDoc, type InspectionStatus } from "../models/Inspection";
import { Order } from "../models/Order";
import type { AuthPrincipal } from "../types/auth";
import { ApiError, notFound } from "../utils/errors";
import { assertScope } from "./accessService";
import { recordAudit } from "./auditService";
import { inspectionQueue } from "./inspectionQueue";
import { findOrder } from "./orderService";

const ACTIVE: InspectionStatus[] = ["pending", "processing"];
const RETRYABLE: InspectionStatus[] = ["failed", "needs_review"];
const UNDECIDED_CLAIM = ["draft", "pending_approval"];

const plannerFor = () => (env.aiMode === "demo" ? "deterministic" : env.AGENT_PLANNER);

/** Create an inspection for an order and queue it. Returns immediately; clients poll for the result. */
export const startInspection = async (principal: AuthPrincipal, orderId: string): Promise<InspectionDoc> => {
    const order = await findOrder(principal, { orderId });
    const active = await Inspection.exists({ orderRef: order._id, status: { $in: ACTIVE } });
    if (active) throw new ApiError("CONFLICT", `An inspection for order ${order.orderId} is already running`);

    const inspection = await Inspection.create({
        orderId: order.orderId,
        orderRef: order._id,
        shopId: order.shopId,
        warehouseId: order.warehouseId,
        task: `Inspect the returned package for order ${order.orderId}.`,
        analysisMode: env.aiMode,
        planner: plannerFor(),
        requestedBy: principal.userId,
        status: "pending",
    });
    await Order.updateOne(
        { _id: order._id },
        { $set: { inspectionStatus: "pending", latestInspectionId: inspection._id } },
    );
    await recordAudit({
        action: "inspection.start",
        actorType: "user",
        actorId: principal.userId,
        shopId: order.shopId,
        orderId: order.orderId,
        inspectionId: inspection.id,
        details: { analysisMode: inspection.analysisMode, planner: inspection.planner },
    });
    inspectionQueue.enqueue(inspection.id);
    return inspection;
};

export const getInspectionForPrincipal = async (principal: AuthPrincipal, inspectionId: string) => {
    const inspection = await Inspection.findById(inspectionId);
    if (!inspection) throw notFound("Inspection");
    assertScope(principal, inspection, "Inspection");
    return inspection;
};

export const listOrderInspections = async (principal: AuthPrincipal, orderId: string) => {
    const order = await findOrder(principal, { orderId });
    return Inspection.find({ orderRef: order._id })
        .sort({ createdAt: -1 })
        .select(
            "status workflowState attempt analysisMode planner summary recommendedAction createdAt finishedAt claimId",
        )
        .limit(20)
        .exec();
};

/**
 * Re-run a failed or escalated inspection (for example after a reviewer uploaded replacement evidence).
 * The run history is kept; results of the previous attempt are cleared and its review task is resolved.
 */
export const retryInspection = async (principal: AuthPrincipal, inspectionId: string): Promise<InspectionDoc> => {
    const inspection = await getInspectionForPrincipal(principal, inspectionId);
    if (!RETRYABLE.includes(inspection.status)) {
        throw new ApiError(
            "INVALID_STATE",
            `Only failed or needs_review inspections can be retried (status: ${inspection.status})`,
        );
    }
    if (inspection.claimId) {
        const claim = await Claim.findById(inspection.claimId);
        if (claim && UNDECIDED_CLAIM.includes(claim.status)) {
            throw new ApiError(
                "INVALID_STATE",
                "This inspection has a draft claim awaiting a decision. Approve or reject it before retrying.",
            );
        }
    }
    const active = await Inspection.exists({ orderRef: inspection.orderRef, status: { $in: ACTIVE } });
    if (active) throw new ApiError("CONFLICT", "Another inspection for this order is already running");

    const previousAttempt = inspection.attempt;
    if (inspection.reviewTask?.status === "open") {
        inspection.set("reviewTask.status", "resolved");
        inspection.set("reviewTask.resolvedAt", new Date());
        inspection.set("reviewTask.resolvedBy", principal.userId);
        inspection.set("reviewTask.resolutionNote", `Inspection retried (attempt ${previousAttempt + 1})`);
    }
    inspection.set({
        attempt: previousAttempt + 1,
        status: "pending",
        workflowState: "RECEIVED",
        analysisMode: env.aiMode,
        planner: plannerFor(),
        requestedBy: principal.userId,
        evidenceValidation: undefined,
        outboundAnalysis: undefined,
        returnAnalysis: undefined,
        comparison: undefined,
        productMatch: undefined,
        confidence: undefined,
        uncertainty: [],
        frameReferences: [],
        segmentInspections: [],
        analysisHistory: [],
        budgetUsage: undefined,
        escalation: { required: false, blocking: false, reasons: [] },
        summary: undefined,
        recommendedAction: undefined,
        agentNarrative: undefined,
        plannerFallback: false,
        claimId: undefined,
        error: undefined,
        startedAt: undefined,
        finishedAt: undefined,
    });
    inspection.agentLog.push({
        kind: "note",
        attempt: previousAttempt + 1,
        message: `Retry requested by user ${principal.userId}`,
    });
    await inspection.save();
    await Order.updateOne(
        { _id: inspection.orderRef },
        { $set: { inspectionStatus: "pending", latestInspectionId: inspection._id } },
    );
    await recordAudit({
        action: "inspection.retry",
        actorType: "user",
        actorId: principal.userId,
        shopId: inspection.shopId,
        orderId: inspection.orderId,
        inspectionId: inspection.id,
        details: { attempt: inspection.attempt },
    });
    inspectionQueue.enqueue(inspection.id);
    return inspection;
};

/** Frame image URLs are added so clients can show cited evidence without knowing storage keys. */
export const serializeInspection = (inspection: InspectionDoc) => {
    const plain = inspection.toObject({ versionKey: false });
    return {
        ...plain,
        frameReferences: (plain.frameReferences ?? []).map((ref) => ({
            ...ref,
            imageUrl: ref.mediaId ? `/api/media/${ref.mediaId}/frames/${ref.frameId}` : null,
        })),
        statusUrl: `/api/inspections/${inspection.id}`,
    };
};
