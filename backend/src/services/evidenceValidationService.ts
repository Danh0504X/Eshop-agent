import type { AnalysisRecord } from "../agent/schemas";
import { env } from "../config/env";
import { MediaEvidence, type MediaDoc, type MediaType } from "../models/MediaEvidence";
import type { OrderDoc } from "../models/Order";
import { normalizeCode, type ComparisonResult } from "./comparisonService";
import { storage } from "./storageService";
import { verifyFramesOnDisk } from "./videoProcessingService";

/**
 * Evidence validation and escalation policy. All decisions here are deterministic backend rules:
 * a high model confidence never overrides missing, unreadable, unclear or contradictory evidence.
 */

export type EscalationCode =
    | "EVIDENCE_MISSING"
    | "FILE_UNREADABLE"
    | "EXTRACTION_FAILED"
    | "FRAMES_MISSING"
    | "POOR_VIDEO_QUALITY"
    | "POSSIBLE_DISCONTINUITY"
    | "ANALYSIS_UNUSABLE"
    | "LOW_CONFIDENCE"
    | "ORDER_ID_NOT_VISIBLE"
    | "ORDER_ID_MISMATCH"
    | "KEY_ATTRIBUTE_UNVERIFIABLE"
    | "INSTRUCTION_TEXT_IN_FOOTAGE"
    | "HIGH_VALUE_ORDER"
    | "WORKFLOW_ERROR";

export interface EscalationReason {
    code: EscalationCode;
    message: string;
    /** Blocking reasons prevent a definitive conclusion; advisory ones still require a human look. */
    blocking: boolean;
    evidenceType?: MediaType;
}

export interface ValidationCheck {
    name: string;
    evidenceType?: MediaType;
    status: "pass" | "fail" | "warn" | "pending";
    detail: string;
}

export type ValidationStage = "initial" | "final";

export interface EvidenceValidation {
    stage: ValidationStage;
    ok: boolean;
    checks: ValidationCheck[];
    missing: string[];
    escalationReasons: EscalationReason[];
    blocking: boolean;
    validatedAt: string;
}

export interface ValidationInput {
    order: OrderDoc;
    stage: ValidationStage;
    analyses?: Partial<Record<MediaType, AnalysisRecord>>;
    comparison?: ComparisonResult;
}

const TYPES: MediaType[] = ["outbound", "return"];
const LABEL: Record<MediaType, string> = { outbound: "outbound packing video", return: "return opening video" };

export const activeMediaFor = async (order: OrderDoc, type: MediaType): Promise<MediaDoc | null> => {
    const ids = type === "outbound" ? order.packingMedia : order.returnMedia;
    if (!ids?.length) return null;
    return MediaEvidence.findOne({ _id: { $in: ids }, status: { $nin: ["superseded", "deleted"] } });
};

export const validateEvidence = async (input: ValidationInput): Promise<EvidenceValidation> => {
    const { order, stage } = input;
    const checks: ValidationCheck[] = [];
    const reasons: EscalationReason[] = [];
    const missing: string[] = [];
    const reason = (r: EscalationReason) => reasons.push(r);

    for (const type of TYPES) {
        const media = await activeMediaFor(order, type);
        if (!media) {
            missing.push(LABEL[type]);
            checks.push({
                name: "evidence_present",
                evidenceType: type,
                status: "fail",
                detail: `No ${LABEL[type]} is linked`,
            });
            reason({ code: "EVIDENCE_MISSING", blocking: true, evidenceType: type, message: `Missing ${LABEL[type]}` });
            continue;
        }
        checks.push({ name: "evidence_present", evidenceType: type, status: "pass", detail: `Media ${media.id}` });

        if (media.orderId !== order.orderId || media.shopId !== order.shopId) {
            checks.push({
                name: "order_association",
                evidenceType: type,
                status: "fail",
                detail: "Media belongs to another order",
            });
            reason({
                code: "ORDER_ID_MISMATCH",
                blocking: true,
                evidenceType: type,
                message: `${LABEL[type]} is associated with another order`,
            });
            continue;
        }

        if (!(await storage().exists(media.storageKey))) {
            checks.push({
                name: "file_readable",
                evidenceType: type,
                status: "fail",
                detail: "File missing or unreadable",
            });
            reason({
                code: "FILE_UNREADABLE",
                blocking: true,
                evidenceType: type,
                message: `The ${LABEL[type]} file cannot be read`,
            });
            continue;
        }
        checks.push({ name: "file_readable", evidenceType: type, status: "pass", detail: "File readable" });

        if (media.status === "failed") {
            checks.push({
                name: "frames_extracted",
                evidenceType: type,
                status: "fail",
                detail: media.processingError ?? "Processing failed",
            });
            reason({
                code: "EXTRACTION_FAILED",
                blocking: true,
                evidenceType: type,
                message: `Frames could not be extracted from the ${LABEL[type]}: ${media.processingError ?? "unknown error"}`,
            });
            continue;
        }
        if (media.frames.length === 0) {
            checks.push({
                name: "frames_extracted",
                evidenceType: type,
                status: stage === "final" ? "fail" : "pending",
                detail: "Frames not extracted yet",
            });
            if (stage === "final") {
                reason({
                    code: "FRAMES_MISSING",
                    blocking: true,
                    evidenceType: type,
                    message: `No frames were extracted from the ${LABEL[type]}`,
                });
            }
            continue;
        }
        const missingFrames = await verifyFramesOnDisk(media);
        if (missingFrames.length) {
            checks.push({
                name: "frames_extracted",
                evidenceType: type,
                status: "fail",
                detail: `Missing frames ${missingFrames.join(", ")}`,
            });
            reason({
                code: "FRAMES_MISSING",
                blocking: true,
                evidenceType: type,
                message: `Extracted frames are missing for the ${LABEL[type]}`,
            });
            continue;
        }
        checks.push({
            name: "frames_extracted",
            evidenceType: type,
            status: "pass",
            detail: `${media.frames.length} frames`,
        });

        const q = media.quality;
        const dark = q?.darkFrameRatio ?? 0;
        const blurry = q?.blurryFrameRatio ?? 0;
        if (dark > env.MAX_BAD_FRAME_RATIO || blurry > env.MAX_BAD_FRAME_RATIO) {
            checks.push({
                name: "footage_clarity",
                evidenceType: type,
                status: "fail",
                detail: `dark ${(dark * 100).toFixed(0)}%, blurry ${(blurry * 100).toFixed(0)}% of sampled frames`,
            });
            reason({
                code: "POOR_VIDEO_QUALITY",
                blocking: true,
                evidenceType: type,
                message: `The ${LABEL[type]} is too dark or blurry to support a conclusion`,
            });
        } else {
            checks.push({
                name: "footage_clarity",
                evidenceType: type,
                status: "pass",
                detail: "Sampled frames are clear enough",
            });
        }
        if (q?.continuous === false) {
            checks.push({
                name: "footage_continuity",
                evidenceType: type,
                status: "fail",
                detail: `Largest timestamp gap ${q.maxTimestampGapSec?.toFixed(2)} s`,
            });
            reason({
                code: "POSSIBLE_DISCONTINUITY",
                blocking: true,
                evidenceType: type,
                message: `The ${LABEL[type]} has a gap of ${q.maxTimestampGapSec?.toFixed(1)} s; the recording may have been cut`,
            });
        } else {
            checks.push({
                name: "footage_continuity",
                evidenceType: type,
                status: "pass",
                detail: "No large timestamp gaps (continuity is only partially verifiable automatically)",
            });
        }
    }

    if (input.analyses) validateAnalyses(input, checks, reason);
    if (input.comparison) validateComparison(input.comparison, checks, reason);

    if (order.declaredValue >= env.HIGH_VALUE_THRESHOLD) {
        reason({
            code: "HIGH_VALUE_ORDER",
            blocking: false,
            message: `Declared value ${order.declaredValue} ${order.currency} is at or above the ${env.HIGH_VALUE_THRESHOLD} review threshold`,
        });
    }

    const blocking = reasons.some((r) => r.blocking);
    const pending = checks.some((c) => c.status === "pending");
    return {
        stage,
        ok: !blocking && (stage === "initial" || !pending),
        checks,
        missing,
        escalationReasons: reasons,
        blocking,
        validatedAt: new Date().toISOString(),
    };
};

const validateAnalyses = (input: ValidationInput, checks: ValidationCheck[], reason: (r: EscalationReason) => void) => {
    const { order, analyses = {}, stage } = input;
    const expectedIds = new Set([normalizeCode(order.orderId), normalizeCode(order.trackingCode)]);

    for (const type of TYPES) {
        const record = analyses[type];
        if (!record) {
            if (stage === "final") {
                checks.push({ name: "analysis_available", evidenceType: type, status: "fail", detail: "No analysis" });
                reason({
                    code: "ANALYSIS_UNUSABLE",
                    blocking: true,
                    evidenceType: type,
                    message: `The ${LABEL[type]} was not analysed`,
                });
            }
            continue;
        }
        const a = record.result;
        if (a.imageConditions.lighting === "unusable" || a.imageConditions.focus === "unusable") {
            checks.push({
                name: "analysis_usable",
                evidenceType: type,
                status: "fail",
                detail: a.imageConditions.notes,
            });
            reason({
                code: "ANALYSIS_UNUSABLE",
                blocking: true,
                evidenceType: type,
                message: `The analysis reports the ${LABEL[type]} frames as unusable`,
            });
        }
        if (a.imageConditions.continuity === "possible_cut") {
            checks.push({
                name: "analysis_continuity",
                evidenceType: type,
                status: "warn",
                detail: "Analysis suggests a possible cut",
            });
            reason({
                code: "POSSIBLE_DISCONTINUITY",
                blocking: true,
                evidenceType: type,
                message: `The analysis suggests the ${LABEL[type]} may be cut`,
            });
        }
        if (a.overallConfidence < env.CONFIDENCE_THRESHOLD) {
            checks.push({
                name: "analysis_confidence",
                evidenceType: type,
                status: "fail",
                detail: `Model-reported confidence ${a.overallConfidence.toFixed(2)} < threshold ${env.CONFIDENCE_THRESHOLD}`,
            });
            reason({
                code: "LOW_CONFIDENCE",
                blocking: true,
                evidenceType: type,
                message: `Analysis confidence for the ${LABEL[type]} (${a.overallConfidence.toFixed(2)}) is below ${env.CONFIDENCE_THRESHOLD}`,
            });
        } else {
            checks.push({
                name: "analysis_confidence",
                evidenceType: type,
                status: "pass",
                detail: a.overallConfidence.toFixed(2),
            });
        }
        if (a.suspectedInstructionText.length) {
            checks.push({
                name: "untrusted_text",
                evidenceType: type,
                status: "warn",
                detail: "Footage contains text addressed to the AI",
            });
            reason({
                code: "INSTRUCTION_TEXT_IN_FOOTAGE",
                blocking: false,
                evidenceType: type,
                message: `The ${LABEL[type]} contains text that reads like instructions to the AI; it was ignored and needs human review`,
            });
        }

        // Order association via identifiers visible on labels.
        const ids = a.visibleIdentifiers.filter((v) => v.kind === "order_id" || v.kind === "tracking_code");
        const mismatched = ids.filter((v) => !expectedIds.has(normalizeCode(v.text)));
        if (mismatched.length) {
            checks.push({
                name: "order_identifier",
                evidenceType: type,
                status: "fail",
                detail: `Visible identifier(s) ${mismatched.map((m) => `${m.text} (${m.frameIds.join(", ")})`).join("; ")} do not match the order`,
            });
            reason({
                code: "ORDER_ID_MISMATCH",
                blocking: true,
                evidenceType: type,
                message: `The ${LABEL[type]} shows identifier ${mismatched[0].text}, which does not match order ${order.orderId}`,
            });
        } else if (ids.length === 0) {
            checks.push({
                name: "order_identifier",
                evidenceType: type,
                status: env.REQUIRE_VISIBLE_ORDER_ID ? "fail" : "warn",
                detail: "No order ID or tracking code is legible in the analysed frames",
            });
            if (env.REQUIRE_VISIBLE_ORDER_ID) {
                reason({
                    code: "ORDER_ID_NOT_VISIBLE",
                    blocking: true,
                    evidenceType: type,
                    message: `The ${LABEL[type]} does not show a legible order ID or tracking code, so it cannot be reliably matched to the order`,
                });
            }
        } else {
            checks.push({
                name: "order_identifier",
                evidenceType: type,
                status: "pass",
                detail: `Matches (${ids.map((i) => i.frameIds.join(",")).join("; ")})`,
            });
        }
    }
};

const validateComparison = (
    comparison: ComparisonResult,
    checks: ValidationCheck[],
    reason: (r: EscalationReason) => void,
) => {
    // Without these, neither "discrepancy" nor "all good" can be concluded.
    const key = ["Package contents", "Item quantity"];
    const unverifiedKey = comparison.unverifiedAttributes.filter((a) => key.includes(a));
    if (unverifiedKey.length) {
        checks.push({ name: "key_attributes", status: "fail", detail: `Unverifiable: ${unverifiedKey.join(", ")}` });
        reason({
            code: "KEY_ATTRIBUTE_UNVERIFIABLE",
            blocking: true,
            message: `Could not verify ${unverifiedKey.join(" and ").toLowerCase()} from the footage`,
        });
    } else {
        checks.push({
            name: "key_attributes",
            status: "pass",
            detail: "Package contents and quantity were comparable",
        });
    }
    if (!comparison.meetsThreshold) {
        checks.push({
            name: "comparison_confidence",
            status: "fail",
            detail: `Confidence ${comparison.overallConfidence.toFixed(2)}`,
        });
        reason({
            code: "LOW_CONFIDENCE",
            blocking: true,
            message: `Comparison confidence ${comparison.overallConfidence.toFixed(2)} is below ${env.CONFIDENCE_THRESHOLD}; no definitive conclusion`,
        });
    }
};
