import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
    attributeText,
    ESCALATION_TEXT,
    FINDING_TITLE,
    MATCH_VERDICT,
    observationText,
    PROGRESS_STEPS,
    progressIndex,
    SEVERITY,
    verdict,
} from "../lib/inspectionText";
import { formatDateTime } from "../lib/orderStatus";
import type { Finding, Inspection } from "../lib/types";
import { AuthImage } from "./AuthImage";
import { IconCheck } from "./icons";
import { Alert, Button, Card, cx, ErrorAlert, Pill, Spinner } from "./ui";

const POLL_MS = 1500;
const isRunning = (inspection: Inspection | null) =>
    inspection?.status === "pending" || inspection?.status === "processing";

const FindingRow = ({ finding, inspection }: { finding: Finding; inspection: Inspection }) => {
    const severity = SEVERITY[finding.severity];
    // One supporting frame from each video, next to each other.
    const frames = (["outbound", "return"] as const).flatMap((type) => {
        const evidence = finding.evidence.find((e) => e.type === type);
        const reference = inspection.frameReferences.find((f) => f.frameId === evidence?.frameId);
        return evidence && reference?.imageUrl ? [{ type, evidence, imageUrl: reference.imageUrl }] : [];
    });
    return (
        <li className="finding">
            <div className="finding-head">
                <span className="finding-title">{FINDING_TITLE[finding.category] ?? finding.category}</span>
                {severity && <Pill tone={severity.tone}>{severity.label}</Pill>}
            </div>
            <p className="finding-compare">
                Lúc đóng gói: <b>{observationText(finding.outboundObservation)}</b> · Khi hoàn trả:{" "}
                <b>{observationText(finding.returnObservation)}</b>
            </p>
            {frames.length > 0 && (
                <div className="finding-frames">
                    {frames.map(({ type, evidence, imageUrl }) => (
                        <figure key={type}>
                            <AuthImage src={imageUrl} alt={`Khung hình ${evidence.frameId}`} />
                            <figcaption>
                                {type === "outbound" ? "Đóng gói" : "Hoàn trả"}
                                {evidence.timestampSec !== null && ` · ${evidence.timestampSec.toFixed(1)} giây`}
                            </figcaption>
                        </figure>
                    ))}
                </div>
            )}
        </li>
    );
};

const Result = ({ inspection }: { inspection: Inspection }) => {
    const { tone, title } = verdict(inspection);
    const findings = (inspection.comparison?.findings ?? []).filter((f) => f.severity !== "info");
    const unverified = inspection.comparison?.unverifiedAttributes ?? [];
    const reasons = inspection.reviewTask?.status === "open" ? (inspection.escalation?.reasons ?? []) : [];
    const technical = [inspection.error, ...(inspection.reviewTask?.reasons ?? [])].filter(Boolean);
    return (
        <div className="stack">
            <Alert tone={tone} title={title}>
                Kiểm tra lúc {formatDateTime(inspection.finishedAt ?? inspection.createdAt)}
            </Alert>
            {inspection.analysisMode === "demo" && (
                <Alert tone="warn" title="Kết quả demo">
                    Đây là dữ liệu định sẵn, không phải kết quả phân tích của AI.
                </Alert>
            )}
            {reasons.length > 0 && (
                <div>
                    <p className="section-label">Lý do cần người xem</p>
                    <ul className="plain-list">
                        {reasons.map((code) => (
                            <li key={code}>{ESCALATION_TEXT[code] ?? code}</li>
                        ))}
                    </ul>
                </div>
            )}
            {findings.length > 0 && (
                <div>
                    <p className="section-label">Khác biệt quan sát được</p>
                    <ul className="finding-list">
                        {findings.map((finding) => (
                            <FindingRow key={finding.id} finding={finding} inspection={inspection} />
                        ))}
                    </ul>
                </div>
            )}
            {inspection.productMatch && (
                <p className="evidence-meta">
                    AI đã so trực tiếp khung hình của 2 video:{" "}
                    {inspection.productMatch.checks
                        .map((c) => `${attributeText(c.label)} ${MATCH_VERDICT[c.verdict] ?? c.verdict}`)
                        .join(", ")}
                    .
                </p>
            )}
            {unverified.length > 0 && (
                <p className="evidence-meta">Chưa xác minh được: {unverified.map(attributeText).join(", ")}.</p>
            )}
            {findings.length > 0 && (
                <p className="evidence-meta">
                    Đây là khác biệt nhìn thấy giữa hai video, không phải bằng chứng lỗi của ai. Cần người xem trước khi
                    xử lý.
                </p>
            )}
            {technical.length > 0 && (
                <details className="technical">
                    <summary>Chi tiết kỹ thuật</summary>
                    {technical.map((line) => (
                        <p key={line}>{line}</p>
                    ))}
                </details>
            )}
        </div>
    );
};

/**
 * Starts the AI inspection of an order and shows its progress and result in plain language. The whole result
 * comes from the backend; agent logs stay in the server terminal.
 */
export const InspectionCard = ({
    orderId,
    initialInspectionId,
    ready,
    onChanged,
}: {
    orderId: string;
    initialInspectionId?: string;
    /** Both evidence videos exist. */
    ready: boolean;
    onChanged: () => void;
}) => {
    const [inspectionId, setInspectionId] = useState(initialInspectionId);
    const [inspection, setInspection] = useState<Inspection | null>(null);
    const [run, setRun] = useState(0);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const notify = useRef(onChanged);
    notify.current = onChanged;

    // Load the inspection and poll it until it finishes.
    useEffect(() => {
        if (!inspectionId) return;
        let cancelled = false;
        let timer: number | undefined;
        let wasRunning = false;
        const load = async () => {
            try {
                const result = await api.getInspection(inspectionId);
                if (cancelled) return;
                setInspection(result.inspection);
                if (isRunning(result.inspection)) {
                    wasRunning = true;
                    timer = window.setTimeout(load, POLL_MS);
                } else if (wasRunning) {
                    notify.current();
                }
            } catch (e) {
                if (!cancelled) setError(e);
            }
        };
        void load();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [inspectionId, run]);

    const start = async () => {
        setStarting(true);
        setError(null);
        try {
            // A failed or escalated inspection is retried; a finished one is run again as a new inspection.
            const canRetry = inspection?.status === "failed" || inspection?.status === "needs_review";
            const result = canRetry ? await api.retryInspection(inspection._id) : await api.startInspection(orderId);
            setInspection(result.inspection);
            setInspectionId(result.inspection._id);
            setRun((n) => n + 1);
            notify.current();
        } catch (e) {
            setError(e);
        } finally {
            setStarting(false);
        }
    };

    const running = isRunning(inspection);
    const loading = Boolean(inspectionId) && !inspection && !error;
    const current = inspection ? progressIndex(inspection.workflowState) : 0;

    return (
        <Card title="Kiểm tra bằng AI">
            <div className="stack">
                {loading && (
                    <div className="inline-loading">
                        <Spinner />
                    </div>
                )}

                {running && (
                    <div className="stack">
                        <p className="running-text">
                            <Spinner small /> Đang kiểm tra, có thể mất vài phút…
                        </p>
                        <ol className="progress-steps">
                            {PROGRESS_STEPS.map((label, i) => (
                                <li key={label} className={cx(i < current && "done", i === current && "current")}>
                                    <span className="step-num">{i < current ? <IconCheck size={14} /> : i + 1}</span>
                                    {label}
                                </li>
                            ))}
                        </ol>
                    </div>
                )}

                {inspection && !running && <Result inspection={inspection} />}

                {!inspection && !loading && (
                    <p className="field-hint">
                        {ready
                            ? "AI so sánh video đóng gói với video hoàn trả rồi đưa ra kết luận. Mỗi lần kiểm tra dùng lượt gọi AI."
                            : "Cần có đủ video đóng gói và video hoàn trả mới kiểm tra được."}
                    </p>
                )}

                <ErrorAlert error={error} />

                {ready && !running && !loading && (
                    <div className="row-actions">
                        <Button variant={inspection ? "secondary" : "primary"} busy={starting} onClick={start}>
                            {inspection ? "Kiểm tra lại" : "Kiểm tra bằng AI"}
                        </Button>
                    </div>
                )}
            </div>
        </Card>
    );
};
