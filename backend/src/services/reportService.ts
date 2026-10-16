import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import type { AnalysisRecord } from "../agent/schemas";
import type { MediaDoc } from "../models/MediaEvidence";
import type { OrderDoc } from "../models/Order";
import { redactText, toLatin1 } from "../utils/redact";
import type { ComparisonResult, Finding } from "./comparisonService";
import type { EvidenceValidation } from "./evidenceValidationService";
import { blurImage } from "./ffmpegService";
import { storage } from "./storageService";

export interface ReportFrame {
    frameId: string;
    type: "outbound" | "return";
    timestampSec: number;
    storageKey: string;
    blur: boolean;
}

export interface ReportModel {
    title: string;
    banners: string[];
    generatedAt: string;
    analysisMode: "real" | "demo";
    model: string | null;
    order: {
        orderId: string;
        trackingCode: string;
        product: string;
        expectedQuantity: number;
        accessories: string;
        declaredValue: string;
    };
    summary: string;
    findings: Array<{
        id: string;
        severity: string;
        confidence: string;
        certainty: string;
        description: string;
        outbound: string;
        returned: string;
        evidence: string;
    }>;
    validationWarnings: string[];
    uncertaintyNotes: string[];
    frames: ReportFrame[];
    disclaimer: string;
    privacyNotes: string[];
    redaction: {
        textRedactions: number;
        framesBlurred: number;
        framesIncluded: number;
        fullyAnonymized: false;
        privacyReviewRequired: true;
    };
}

export interface ReportInput {
    order: OrderDoc;
    summary: string;
    comparison: ComparisonResult;
    validation?: EvidenceValidation;
    analyses: { outbound: AnalysisRecord; return: AnalysisRecord };
    media: { outbound: MediaDoc; return: MediaDoc };
    analysisMode: "real" | "demo";
    maxFrames?: number;
}

const fmtTime = (t: number | null) => (t === null ? "?" : `${t.toFixed(1)}s`);

/** Pure function: builds the report content with every string redacted. Customer fields are never included. */
export const buildReportModel = (input: ReportInput): ReportModel => {
    const { order, comparison, analyses } = input;
    const known = [order.customer?.name, order.customer?.phone, order.customer?.address];
    let textRedactions = 0;
    const r = (value: string | null | undefined): string => {
        if (!value) return "";
        const out = redactText(value, known);
        textRedactions += out.count;
        return out.text;
    };

    const reportable = comparison.findings.filter((f) => f.category !== "unverifiable_attribute");
    const flagged = new Set([
        ...analyses.outbound.result.privacy.framesWithPeople,
        ...analyses.outbound.result.privacy.framesWithPersonalData,
        ...analyses.return.result.privacy.framesWithPeople,
        ...analyses.return.result.privacy.framesWithPersonalData,
    ]);

    // Frames cited by findings, outbound first, de-duplicated and capped.
    const cited = new Map<string, Finding["evidence"][number]>();
    for (const f of reportable) for (const e of f.evidence) if (!cited.has(e.frameId)) cited.set(e.frameId, e);
    const frames: ReportFrame[] = [];
    for (const ref of [...cited.values()].sort((a, b) => (a.type === b.type ? 0 : a.type === "outbound" ? -1 : 1))) {
        if (frames.length >= (input.maxFrames ?? 8)) break;
        const media = input.media[ref.type];
        const frame = media.frames.find((f) => f.frameId === ref.frameId);
        if (!frame) continue;
        frames.push({
            frameId: frame.frameId,
            type: ref.type,
            timestampSec: frame.timestampSec,
            storageKey: frame.storageKey,
            blur: flagged.has(frame.frameId),
        });
    }

    const uncertaintyNotes = [
        ...comparison.unverifiedAttributes.map((a) => `Not verifiable from the footage: ${a}`),
        ...analyses.outbound.result.uncertaintyNotes.map((n) => `Outbound: ${n}`),
        ...analyses.return.result.uncertaintyNotes.map((n) => `Return: ${n}`),
        `Model-reported confidence ${comparison.overallConfidence.toFixed(2)} (not a calibrated probability).`,
    ];

    const framesBlurred = frames.filter((f) => f.blur).length;
    return {
        title: `Return inspection claim draft - ${order.orderId}`,
        banners: [
            "AI-GENERATED DRAFT - PENDING HUMAN REVIEW. Not a final determination.",
            ...(input.analysisMode === "demo"
                ? ["DEMO MODE: findings use predefined demo data, NOT real AI analysis."]
                : []),
        ],
        generatedAt: new Date().toISOString(),
        analysisMode: input.analysisMode,
        model: analyses.return.model ?? analyses.outbound.model,
        order: {
            orderId: order.orderId,
            trackingCode: order.trackingCode,
            product: r([order.product?.name, order.product?.model, order.product?.color].filter(Boolean).join(" / ")),
            expectedQuantity: order.expectedQuantity,
            accessories: r(order.expectedAccessories.join(", ")) || "none",
            declaredValue: `${order.declaredValue} ${order.currency}`,
        },
        summary: r(input.summary),
        findings: reportable.map((f) => ({
            id: f.id,
            severity: f.severity,
            confidence: f.confidence.toFixed(2),
            certainty: f.certainty,
            description: r(f.description),
            outbound: r(f.outboundObservation) || "-",
            returned: r(f.returnObservation) || "-",
            evidence: f.evidence.map((e) => `${e.frameId} @ ${fmtTime(e.timestampSec)}`).join(", ") || "-",
        })),
        validationWarnings: (input.validation?.escalationReasons ?? []).map((e) => r(e.message)),
        uncertaintyNotes: uncertaintyNotes.map(r),
        frames,
        disclaimer: comparison.disclaimer,
        privacyNotes: [
            "Customer name, phone number and address are excluded from this report.",
            "Phone numbers, e-mail addresses and street addresses found in AI-extracted text were redacted automatically (pattern-based, best effort).",
            `${framesBlurred} frame(s) flagged by the analysis as showing people or personal data were fully blurred.`,
            "Automated face detection is NOT performed. Unflagged frames were not verified to be free of faces or personal data.",
            "This report is NOT fully anonymized. A human must complete a privacy review before sharing it outside the company.",
        ],
        redaction: {
            textRedactions,
            framesBlurred,
            framesIncluded: frames.length,
            fullyAnonymized: false,
            privacyReviewRequired: true,
        },
    };
};

const SEVERITY_COLOR: Record<string, string> = {
    critical: "#b00020",
    high: "#d84315",
    medium: "#f9a825",
    low: "#558b2f",
    info: "#607d8b",
};

/** Render the report to a PDF buffer. Frames flagged for privacy are blurred before embedding. */
export const renderReportPdf = async (model: ReportModel, options: { compress?: boolean } = {}): Promise<Buffer> => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fixit-report-"));
    try {
        const images: Array<{ frame: ReportFrame; file: string | null }> = [];
        for (const frame of model.frames) {
            if (!(await storage().exists(frame.storageKey))) {
                images.push({ frame, file: null });
                continue;
            }
            const source = storage().localPath(frame.storageKey);
            if (frame.blur) {
                const out = path.join(tmpDir, `${crypto.randomUUID()}.jpg`);
                await blurImage(source, out);
                images.push({ frame, file: out });
            } else {
                images.push({ frame, file: source });
            }
        }

        const doc = new PDFDocument({
            size: "A4",
            margin: 48,
            compress: options.compress ?? true,
            info: { Title: toLatin1(model.title), Author: "FixIt AI Agent (AI-generated draft)" },
        });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        const done = new Promise<Buffer>((resolve, reject) => {
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);
        });
        const t = (s: string) => toLatin1(s);
        const heading = (s: string) =>
            doc
                .moveDown(0.8)
                .font("Helvetica-Bold")
                .fontSize(13)
                .fillColor("#000")
                .text(t(s))
                .moveDown(0.3)
                .font("Helvetica")
                .fontSize(10);

        doc.font("Helvetica-Bold").fontSize(18).text(t(model.title));
        doc.moveDown(0.5);
        for (const banner of model.banners) {
            doc.font("Helvetica-Bold").fontSize(10).fillColor("#b00020").text(t(banner));
        }
        doc.fillColor("#444")
            .font("Helvetica")
            .fontSize(9)
            .text(
                t(
                    `Generated ${model.generatedAt} | mode: ${model.analysisMode}${model.model ? ` | model: ${model.model}` : ""}`,
                ),
            );

        heading("Order");
        const o = model.order;
        doc.text(t(`Order ID: ${o.orderId}    Tracking: ${o.trackingCode}`));
        doc.text(t(`Product: ${o.product}`));
        doc.text(t(`Expected quantity: ${o.expectedQuantity}    Accessories: ${o.accessories}`));
        doc.text(t(`Declared value: ${o.declaredValue}`));

        heading("Neutral summary");
        doc.text(t(model.summary));

        heading("Findings (visual discrepancies, not proof of wrongdoing)");
        if (!model.findings.length) doc.text("No reportable findings.");
        for (const f of model.findings) {
            doc.font("Helvetica-Bold")
                .fillColor(SEVERITY_COLOR[f.severity] ?? "#000")
                .text(t(`${f.id} [${f.severity.toUpperCase()}] confidence ${f.confidence}, ${f.certainty}`));
            doc.font("Helvetica").fillColor("#000").text(t(f.description));
            doc.fillColor("#333").text(t(`Outbound: ${f.outbound} | Return: ${f.returned}`));
            doc.text(t(`Evidence: ${f.evidence}`)).moveDown(0.4);
        }

        if (model.validationWarnings.length) {
            heading("Evidence validation warnings");
            for (const w of model.validationWarnings) doc.text(t(`- ${w}`));
        }
        heading("Uncertainty");
        for (const n of model.uncertaintyNotes) doc.text(t(`- ${n}`));

        if (images.length) {
            doc.addPage();
            heading("Supporting frames");
            for (const { frame, file } of images) {
                const label = `${frame.frameId} (${frame.type}) @ ${frame.timestampSec.toFixed(1)}s${frame.blur ? " - BLURRED for privacy" : ""}`;
                if (doc.y > 600) doc.addPage();
                doc.font("Helvetica-Bold").fontSize(9).text(t(label));
                if (file) doc.image(file, { fit: [300, 200] });
                else doc.font("Helvetica").text("[frame file unavailable]");
                doc.moveDown(0.5);
            }
        }

        heading("Disclaimer");
        doc.text(t(model.disclaimer));
        heading("Privacy");
        for (const n of model.privacyNotes) doc.text(t(`- ${n}`));

        doc.end();
        return await done;
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    }
};
