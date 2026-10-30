import type { InspectionDoc } from "../models/Inspection";
import type { AuthPrincipal } from "../types/auth";
import { recordAudit } from "./auditService";
import type { Finding } from "./comparisonService";
import type { EscalationReason } from "./evidenceValidationService";

export interface ReviewTaskInput {
    inspection: InspectionDoc;
    principal: AuthPrincipal;
    reasons: EscalationReason[];
    agentNote?: string;
    requiredAction?: string;
    findings?: Finding[];
    actorType: "agent" | "system";
}

const defaultAction = (reasons: EscalationReason[]): string => {
    const codes = new Set(reasons.map((r) => r.code));
    if (codes.has("EVIDENCE_MISSING")) return "Upload the missing evidence video, then retry the inspection.";
    if (codes.has("POOR_VIDEO_QUALITY") || codes.has("ORDER_ID_NOT_VISIBLE"))
        return "Review the footage; if it is unusable, upload a clearer replacement recording and retry the inspection.";
    if (codes.has("ORDER_ID_MISMATCH")) return "Confirm the evidence belongs to this order; replace it if it does not.";
    return "Review the evidence and findings and decide how to proceed.";
};

/**
 * Create or update the human review task on an inspection. Merges with an existing open task.
 * The agent's free-text reason is stored as a note; escalation codes come from backend rules.
 */
export const createReviewTask = async (input: ReviewTaskInput): Promise<InspectionDoc> => {
    const { inspection, reasons } = input;
    const existing = inspection.reviewTask?.status === "open" ? inspection.reviewTask : undefined;
    const messages = [...new Set([...(existing?.reasons ?? []), ...reasons.map((r) => r.message)])];
    if (input.agentNote) messages.push(`Agent note: ${input.agentNote}`);
    const blocking = reasons.some((r) => r.blocking) || Boolean(inspection.escalation?.blocking);

    inspection.set({
        escalation: {
            required: true,
            blocking,
            reasons: [...new Set([...(inspection.escalation?.reasons ?? []), ...reasons.map((r) => r.code)])],
        },
        reviewTask: {
            status: "open",
            reason: reasons[0]?.message ?? input.agentNote ?? "Human review requested",
            reasons: messages,
            findings: input.findings ?? existing?.findings ?? [],
            requiredAction: input.requiredAction ?? existing?.requiredAction ?? defaultAction(reasons),
            createdAt: existing?.createdAt ?? new Date(),
        },
    });
    await inspection.save();
    await recordAudit({
        action: "inspection.review_task",
        actorType: input.actorType,
        actorId: input.principal.userId,
        shopId: inspection.shopId,
        orderId: inspection.orderId,
        inspectionId: inspection.id,
        details: { codes: reasons.map((r) => r.code), blocking },
    });
    return inspection;
};
