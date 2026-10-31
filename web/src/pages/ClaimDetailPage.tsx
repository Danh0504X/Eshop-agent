import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { FindingList } from "../components/FindingList";
import { Alert, Button, Card, ErrorAlert, Field, LinkButton, PageHeader, Pill, Spinner } from "../components/ui";
import { api, downloadFile, openInNewTab } from "../lib/api";
import { useAuth } from "../lib/auth";
import { CLAIM_STATUS, DETERMINATION, DETERMINATIONS, historyReason } from "../lib/claimText";
import { formatDateTime } from "../lib/orderStatus";
import type { Claim, FinalDetermination, Order } from "../lib/types";

const MIN_REASON = 5;

const ReasonField = ({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
}) => (
    <Field label={label} hint={`Bắt buộc, ít nhất ${MIN_REASON} ký tự. Lý do được lưu vào lịch sử.`}>
        <textarea rows={2} maxLength={1000} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
);

/** The moves the backend allows from each status. Only an owner sees this; the backend enforces it as well. */
const ClaimActions = ({ claim, onChanged }: { claim: Claim; onChanged: (claim: Claim) => void }) => {
    const [reason, setReason] = useState("");
    const [determination, setDetermination] = useState<FinalDetermination>("no_determination");
    const [reference, setReference] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);

    const run = async (name: string, action: () => Promise<{ claim: Claim }>) => {
        setBusy(name);
        setError(null);
        try {
            const result = await action();
            setReason("");
            setReference("");
            setNote("");
            onChanged(result.claim);
        } catch (e) {
            setError(e);
        } finally {
            setBusy(null);
        }
    };

    const id = claim._id;
    const text = reason.trim();
    const reasonOk = text.length >= MIN_REASON;
    const undecided = claim.status === "draft" || claim.status === "pending_approval";

    return (
        <div className="stack">
            {undecided && (
                <>
                    <ReasonField label="Lý do quyết định *" value={reason} onChange={setReason} />
                    {claim.status === "pending_approval" ? (
                        <Field label="Kết luận khi duyệt">
                            <select
                                value={determination}
                                onChange={(e) => setDetermination(e.target.value as FinalDetermination)}
                            >
                                {DETERMINATIONS.map((d) => (
                                    <option key={d} value={d}>
                                        {DETERMINATION[d]}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    ) : (
                        <p className="field-hint">Bản nháp chưa có báo cáo nên chưa duyệt được, chỉ có thể từ chối.</p>
                    )}
                    <div className="row-actions">
                        {claim.status === "pending_approval" && (
                            <Button
                                variant="primary"
                                busy={busy === "approve"}
                                disabled={!reasonOk || Boolean(busy)}
                                onClick={() => run("approve", () => api.approveClaim(id, text, determination))}
                            >
                                Duyệt khiếu nại
                            </Button>
                        )}
                        <Button
                            variant="danger"
                            busy={busy === "reject"}
                            disabled={!reasonOk || Boolean(busy)}
                            onClick={() => run("reject", () => api.rejectClaim(id, text))}
                        >
                            Từ chối
                        </Button>
                    </div>
                    <p className="field-hint">Quyết định không hoàn tác được.</p>
                </>
            )}

            {claim.status === "approved" && (
                <div className="stack">
                    <p className="section-label">Ghi nhận đã gửi khiếu nại</p>
                    <p className="field-hint">
                        FixIt không tự gửi khiếu nại ra bên ngoài. Sau khi bạn gửi trên sàn hoặc cho đơn vị vận chuyển,
                        hãy ghi lại ở đây.
                    </p>
                    <Field label="Mã tham chiếu">
                        <input maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} />
                    </Field>
                    <Field label="Ghi chú">
                        <input maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                    </Field>
                    <div className="row-actions">
                        <Button
                            variant="primary"
                            busy={busy === "submit"}
                            disabled={Boolean(busy)}
                            onClick={() =>
                                run("submit", () =>
                                    api.markSubmitted(id, reference.trim() || undefined, note.trim() || undefined),
                                )
                            }
                        >
                            Ghi nhận đã gửi
                        </Button>
                    </div>
                </div>
            )}

            {(claim.status === "approved" || claim.status === "submitted") && (
                <div className="stack">
                    <ReasonField label="Kết quả xử lý *" value={reason} onChange={setReason} />
                    <div className="row-actions">
                        <Button
                            busy={busy === "resolve"}
                            disabled={!reasonOk || Boolean(busy)}
                            onClick={() => run("resolve", () => api.resolveClaim(id, text))}
                        >
                            Đánh dấu đã xong
                        </Button>
                    </div>
                </div>
            )}

            <ErrorAlert error={error} />
        </div>
    );
};

const DecisionCard = ({ claim, onChanged }: { claim: Claim; onChanged: (claim: Claim) => void }) => {
    const { user } = useAuth();
    const open = !["rejected", "resolved"].includes(claim.status);
    const { approval } = claim;
    return (
        <Card title="Quyết định">
            <div className="stack">
                {approval?.decision && (
                    <dl className="meta-list">
                        <dt>Kết quả</dt>
                        <dd>{approval.decision === "approved" ? "Đã duyệt" : "Đã từ chối"}</dd>
                        <dt>Lúc</dt>
                        <dd>{formatDateTime(approval.decidedAt)}</dd>
                        {approval.decision === "approved" && approval.finalDetermination && (
                            <>
                                <dt>Kết luận</dt>
                                <dd>{DETERMINATION[approval.finalDetermination]}</dd>
                            </>
                        )}
                        <dt>Lý do</dt>
                        <dd>{approval.reason}</dd>
                    </dl>
                )}
                {open &&
                    (user?.role === "owner" ? (
                        <ClaimActions claim={claim} onChanged={onChanged} />
                    ) : (
                        <p className="field-hint">Chỉ chủ shop mới cập nhật được khiếu nại này.</p>
                    ))}
            </div>
        </Card>
    );
};

const ReportCard = ({ claim }: { claim: Claim }) => {
    const [busy, setBusy] = useState<"open" | "download" | null>(null);
    const [error, setError] = useState<unknown>(null);
    const reportUrl = claim.reportUrl;
    const { redaction } = claim;

    const run = async (name: "open" | "download", action: () => Promise<void>) => {
        setBusy(name);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(e);
        } finally {
            setBusy(null);
        }
    };

    return (
        <Card title="Báo cáo PDF">
            {reportUrl ? (
                <div className="stack">
                    <div className="row-actions">
                        <Button
                            variant="primary"
                            busy={busy === "open"}
                            disabled={Boolean(busy)}
                            onClick={() => run("open", () => openInNewTab(reportUrl))}
                        >
                            Xem báo cáo
                        </Button>
                        <Button
                            busy={busy === "download"}
                            disabled={Boolean(busy)}
                            onClick={() =>
                                run("download", () => downloadFile(reportUrl, `bao-cao-${claim.orderId}.pdf`))
                            }
                        >
                            Tải PDF
                        </Button>
                    </div>
                    <ErrorAlert error={error} />
                    <dl className="meta-list">
                        <dt>Tạo lúc</dt>
                        <dd>{formatDateTime(claim.reportGeneratedAt)}</dd>
                        {redaction && (
                            <>
                                <dt>Ảnh kèm</dt>
                                <dd>
                                    {redaction.framesIncluded ?? 0} ảnh, làm mờ {redaction.framesBlurred ?? 0}
                                </dd>
                                <dt>Chữ đã che</dt>
                                <dd>{redaction.textRedactions ?? 0} chỗ</dd>
                            </>
                        )}
                    </dl>
                    <Alert tone="warn" title="Chưa ẩn danh hoàn toàn">
                        Báo cáo đã bỏ thông tin khách hàng và che các chỗ nhận diện được, nhưng không tự dò khuôn mặt.
                        Hãy kiểm tra quyền riêng tư trước khi gửi ra ngoài công ty.
                    </Alert>
                    <p className="field-hint">
                        Báo cáo viết bằng tiếng Anh; chữ tiếng Việt trong báo cáo hiện không dấu. Mỗi lần xem hoặc tải
                        đều được ghi nhật ký.
                    </p>
                </div>
            ) : (
                <p className="field-hint">Khiếu nại này chưa có báo cáo.</p>
            )}
        </Card>
    );
};

const HistoryCard = ({ claim }: { claim: Claim }) => {
    const { user } = useAuth();
    const actor = (by?: string) => {
        if (by === "agent") return "AI";
        if (by === "user") return "Hệ thống";
        return by === user?.userId ? "Bạn" : "Chủ shop";
    };
    return (
        <Card title="Lịch sử">
            <ol className="timeline">
                {claim.history.map((entry, i) => (
                    <li key={i}>
                        <p className="timeline-head">
                            <b>{CLAIM_STATUS[entry.to]?.label ?? entry.to}</b>
                            <span className="order-sub">
                                {actor(entry.by)} · {formatDateTime(entry.at)}
                            </span>
                        </p>
                        {entry.reason && <p className="timeline-reason">{historyReason(entry.reason)}</p>}
                    </li>
                ))}
            </ol>
        </Card>
    );
};

/** One AI-drafted claim: what differs, the PDF report, and the owner's decision. */
export const ClaimDetailPage = () => {
    const { claimId = "" } = useParams();
    const [claim, setClaim] = useState<Claim | null>(null);
    const [order, setOrder] = useState<Order | null>(null);
    const [error, setError] = useState<unknown>(null);

    useEffect(() => {
        let cancelled = false;
        setClaim(null);
        setOrder(null);
        setError(null);
        api.getClaim(claimId)
            .then(async (result) => {
                if (cancelled) return;
                setClaim(result.claim);
                // Only adds the tracking code and product to the header, so the page works without it.
                const found = await api.getOrder(result.claim.orderId).catch(() => null);
                if (!cancelled) setOrder(found?.order ?? null);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(e);
            });
        return () => {
            cancelled = true;
        };
    }, [claimId]);

    if (error)
        return (
            <>
                <PageHeader title="Chi tiết khiếu nại" backTo="/claims" />
                <ErrorAlert error={error} />
            </>
        );
    if (!claim)
        return (
            <div className="inline-loading">
                <Spinner />
            </div>
        );

    const status = CLAIM_STATUS[claim.status];
    const findings = claim.findings.filter((f) => f.severity !== "info");
    const frameUrl = (frameId: string) => {
        const mediaId = claim.evidenceReferences.find((e) => e.frameId === frameId)?.mediaId;
        return mediaId ? `/api/media/${mediaId}/frames/${frameId}` : null;
    };
    return (
        <>
            <PageHeader
                backTo="/claims"
                title={
                    <>
                        Khiếu nại đơn <span className="mono">{claim.orderId}</span>
                    </>
                }
                subtitle={order ? `${order.trackingCode} · ${order.product.name}` : undefined}
                actions={<Pill tone={status.tone}>{status.label}</Pill>}
            />
            <div className="claim-detail">
                <div className="stack claim-main">
                    {claim.analysisMode === "demo" && (
                        <Alert tone="warn" title="Kết quả demo">
                            Đây là dữ liệu định sẵn, không phải kết quả phân tích của AI.
                        </Alert>
                    )}
                    <Card
                        title="Khác biệt quan sát được"
                        actions={
                            <LinkButton size="sm" to={`/orders/${encodeURIComponent(claim.orderId)}`}>
                                Xem video trong đơn
                            </LinkButton>
                        }
                    >
                        <div className="stack">
                            <FindingList findings={findings} frameUrl={frameUrl} />
                            <p className="evidence-meta">
                                Đây là khác biệt nhìn thấy giữa hai video, không phải bằng chứng lỗi của ai. AI chỉ soạn
                                bản nháp, người duyệt mới quyết định.
                            </p>
                            {(claim.summary || claim.uncertaintyNotes.length > 0) && (
                                <details className="technical">
                                    <summary>Ghi chú của AI (tiếng Anh)</summary>
                                    <p>{claim.summary}</p>
                                    {claim.uncertaintyNotes.map((line) => (
                                        <p key={line}>{line}</p>
                                    ))}
                                </details>
                            )}
                        </div>
                    </Card>
                </div>
                <div className="stack claim-side">
                    <DecisionCard claim={claim} onChanged={setClaim} />
                    <ReportCard claim={claim} />
                    <HistoryCard claim={claim} />
                </div>
            </div>
        </>
    );
};
