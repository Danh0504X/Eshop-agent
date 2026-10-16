import type { AnalysisRecord } from "../agent/schemas";
import { Claim, type ClaimDoc } from "../models/Claim";
import { Inspection, type InspectionDoc } from "../models/Inspection";
import type { MediaDoc } from "../models/MediaEvidence";
import { Order, type OrderDoc } from "../models/Order";
import type { AuthPrincipal } from "../types/auth";
import { ApiError, notFound } from "../utils/errors";
import { assertRole, assertScope } from "./accessService";
import { recordAudit } from "./auditService";
import type { ComparisonResult } from "./comparisonService";
import type { EvidenceValidation } from "./evidenceValidationService";
import { buildReportModel, renderReportPdf } from "./reportService";
import { safeSegment, storage } from "./storageService";

export interface ClaimPackInput {
    principal: AuthPrincipal;
    inspection: InspectionDoc;
    order: OrderDoc;
    comparison: ComparisonResult;
    validation: EvidenceValidation;
    analyses: { outbound: AnalysisRecord; return: AnalysisRecord };
    media: { outbound: MediaDoc; return: MediaDoc };
    actorType: "agent" | "user";
}

export const buildNeutralSummary = (order: OrderDoc, comparison: ComparisonResult): string =>
    `Automated comparison of the outbound packing recording and the return opening recording for order ${order.orderId}. ` +
    `${comparison.summary} This draft was generated automatically and requires human review before any claim is made.`;

/**
 * Create (or return the existing) draft claim for an inspection and export its PDF.
 * Never submits anything externally. Refuses when blocking escalations exist or nothing material was found.
 */
export const buildClaimPack = async (input: ClaimPackInput): Promise<ClaimDoc> => {
    const { inspection, order, comparison, validation } = input;
    if (validation.blocking) {
        throw new ApiError(
            "INVALID_STATE",
            "Evidence has blocking issues; a claim cannot be drafted until a human reviews it",
        );
    }
    if (comparison.materialDiscrepancyCount === 0) {
        throw new ApiError("INVALID_STATE", "No material discrepancy was observed; no claim is needed");
    }

    const existing = await Claim.findOne({ inspectionId: inspection._id });
    if (existing?.reportStorageKey && (await storage().exists(existing.reportStorageKey))) return existing;

    const summary = buildNeutralSummary(order, comparison);
    const model = buildReportModel({
        order,
        summary,
        comparison,
        validation,
        analyses: input.analyses,
        media: input.media,
        analysisMode: inspection.analysisMode,
    });
    const findings = comparison.findings.filter((f) => f.category !== "unverifiable_attribute");
    const evidenceReferences = [
        ...new Map(
            findings
                .flatMap((f) => f.evidence)
                .map((e) => [
                    e.frameId,
                    {
                        frameId: e.frameId,
                        type: e.type,
                        timestampSec: e.timestampSec ?? undefined,
                        mediaId: input.media[e.type].id,
                    },
                ]),
        ).values(),
    ];

    const claim =
        existing ??
        (await Claim.create({
            orderId: order.orderId,
            orderRef: order._id,
            inspectionId: inspection._id,
            shopId: order.shopId,
            warehouseId: order.warehouseId,
            summary: model.summary,
            findings,
            evidenceReferences,
            uncertaintyNotes: model.uncertaintyNotes,
            analysisMode: inspection.analysisMode,
            currency: order.currency,
            status: "draft",
            history: [{ by: input.actorType, to: "draft", reason: "Draft generated from inspection" }],
        }));

    const pdf = await renderReportPdf(model);
    const key = `reports/${safeSegment(order.shopId)}/${claim.id}.pdf`;
    await storage().writeBuffer(key, pdf);

    claim.set({
        reportStorageKey: key,
        reportGeneratedAt: new Date(),
        redaction: { ...model.redaction, notes: model.privacyNotes },
        status: "pending_approval",
    });
    claim.history.push({
        by: input.actorType,
        from: "draft",
        to: "pending_approval",
        reason: "Report generated; awaiting human review",
    });
    await claim.save();

    // Read back: the claim and its report must both exist before success is reported.
    const persisted = await Claim.findById(claim._id);
    if (!persisted?.reportStorageKey || !(await storage().exists(persisted.reportStorageKey))) {
        throw new ApiError("INTERNAL_ERROR", "Claim report was not persisted");
    }
    await Inspection.updateOne({ _id: inspection._id }, { $set: { claimId: persisted._id } });
    await Order.updateOne({ _id: order._id }, { $set: { latestClaimId: persisted._id } });
    await recordAudit({
        action: "claim.draft_created",
        actorType: input.actorType,
        actorId: input.principal.userId,
        shopId: order.shopId,
        orderId: order.orderId,
        inspectionId: inspection.id,
        claimId: persisted.id,
        details: { findings: findings.length, maxSeverity: comparison.maxSeverity, redaction: model.redaction },
    });
    return persisted;
};

export const getClaimForPrincipal = async (principal: AuthPrincipal, claimId: string): Promise<ClaimDoc> => {
    const claim = await Claim.findById(claimId);
    if (!claim) throw notFound("Claim");
    assertScope(principal, claim, "Claim");
    return claim;
};

export interface RefundInput {
    requestedCompensation: number;
    actualRefund: number;
    note?: string;
}

/**
 * Record amounts entered by an authorized user and flag discrepancies.
 * This does not verify any real payment: there is no authoritative payment integration.
 */
export const trackRefund = async (principal: AuthPrincipal, claimId: string, input: RefundInput): Promise<ClaimDoc> => {
    assertRole(principal, ["owner"], "record refund amounts");
    const claim = await getClaimForPrincipal(principal, claimId);
    const discrepancy = Math.round((input.requestedCompensation - input.actualRefund) * 100) / 100;
    claim.set({
        requestedCompensation: input.requestedCompensation,
        actualRefund: input.actualRefund,
        refund: {
            discrepancyAmount: discrepancy,
            flagged: discrepancy > 0,
            note: input.note,
            recordedBy: principal.userId,
            recordedAt: new Date(),
            paymentVerified: false,
        },
    });
    claim.history.push({
        by: principal.userId,
        from: claim.status,
        to: claim.status,
        reason: `Refund recorded: requested ${input.requestedCompensation}, actual ${input.actualRefund}`,
    });
    await claim.save();
    await recordAudit({
        action: "claim.refund_recorded",
        actorType: "user",
        actorId: principal.userId,
        shopId: claim.shopId,
        orderId: claim.orderId,
        claimId: claim.id,
        details: { ...input, discrepancy, flagged: discrepancy > 0 },
    });
    return claim;
};
