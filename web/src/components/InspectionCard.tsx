import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
    attributeText,
    ESCALATION_TEXT,
    MATCH_VERDICT,
    PROGRESS_STEPS,
    progressIndex,
    runStatus,
    verdict,
} from "../lib/inspectionText";
import { formatDateTime } from "../lib/orderStatus";
import type { Inspection, InspectionRun } from "../lib/types";
import { FindingList } from "./FindingList";
import { IconCheck } from "./icons";
import { Alert, Button, Card, cx, ErrorAlert, LinkButton, Pill, Spinner } from "./ui";

const POLL_MS = 1500;
const isRunning = (inspection: Inspection | null) =>
    inspection?.status === "pending" || inspection?.status === "processing";

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
            {inspection.claimId && (
                <div className="row-actions">
                    <LinkButton to={`/claims/${inspection.claimId}`} variant="primary">
                        Xem khiếu nại và báo cáo
                    </LinkButton>
                </div>
            )}
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
                    <FindingList
                        findings={findings}
                        frameUrl={(frameId) => inspection.frameReferences.find((f) => f.frameId === frameId)?.imageUrl}
                    />
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
    /** The run new checks continue from; `inspectionId` can point at an older one from the history. */
    const [latestId, setLatestId] = useState(initialInspectionId);
    const [inspection, setInspection] = useState<Inspection | null>(null);
    const [history, setHistory] = useState<InspectionRun[]>([]);
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

    // The history only adds to the card, so a failure to load it is not shown.
    const status = inspection?.status;
    useEffect(() => {
        if (!latestId) return;
        let cancelled = false;
        api.listInspections(orderId)
            .then((result) => {
                if (!cancelled) setHistory(result.inspections);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [orderId, latestId, status]);

    const view = (id: string) => {
        setError(null);
        setInspection(null);
        setInspectionId(id);
    };

    const start = async () => {
        setStarting(true);
        setError(null);
        try {
            // A failed or escalated inspection is retried; a finished one is run again as a new inspection.
            const canRetry = inspection?.status === "failed" || inspection?.status === "needs_review";
            const result = canRetry ? await api.retryInspection(inspection._id) : await api.startInspection(orderId);
            setInspection(result.inspection);
            setInspectionId(result.inspection._id);
            setLatestId(result.inspection._id);
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
    const viewingOlder = inspectionId !== latestId;

    return (
        <Card title="Kiểm tra bằng AI">
            <div className="stack">
                {viewingOlder && latestId && (
                    <Alert tone="info" title="Đang xem một lần kiểm tra trước đây">
                        <Button size="sm" onClick={() => view(latestId)}>
                            Về lần mới nhất
                        </Button>
                    </Alert>
                )}

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

                {ready && !running && !loading && !viewingOlder && (
                    <div className="row-actions">
                        <Button variant={inspection ? "secondary" : "primary"} busy={starting} onClick={start}>
                            {inspection ? "Kiểm tra lại" : "Kiểm tra bằng AI"}
                        </Button>
                    </div>
                )}

                {/* Leaving a running check would stop the polling that updates the order page when it ends. */}
                {history.length > 1 && !running && (
                    <details className="technical">
                        <summary>Các lần kiểm tra ({history.length})</summary>
                        <ul className="run-list">
                            {history.map((item) => {
                                const outcome = runStatus(item);
                                return (
                                    <li key={item._id}>
                                        <button
                                            type="button"
                                            className={cx("run-row", item._id === inspectionId && "active")}
                                            aria-current={item._id === inspectionId ? "true" : undefined}
                                            onClick={() => view(item._id)}
                                        >
                                            <span>{formatDateTime(item.finishedAt ?? item.createdAt)}</span>
                                            <Pill tone={outcome.tone}>{outcome.label}</Pill>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </details>
                )}
            </div>
        </Card>
    );
};
