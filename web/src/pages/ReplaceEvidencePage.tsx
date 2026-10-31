import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";
import { IconCheck } from "../components/icons";
import { LabelScanner } from "../components/LabelScanner";
import { Alert, Button, Card, ErrorAlert, Field, LinkButton, PageHeader, Spinner } from "../components/ui";
import { VideoCapture, type Capture } from "../components/VideoCapture";
import { ProgressBar, Stepper } from "../components/wizard";
import { api } from "../lib/api";
import { useHealth } from "../lib/health";
import type { Order, Scan, ScanMethod } from "../lib/types";

type Step = "scan" | "video" | "done";

const STEPS = [
    { id: "scan", label: "Quét mã vận đơn" },
    { id: "video", label: "Lý do và video mới" },
];

const MIN_REASON = 5;

/**
 * Replace an order's evidence video. Like any upload it needs a fresh scan of the order's own label, plus a
 * reason; the old video is kept by the backend as superseded.
 */
export const ReplaceEvidencePage = () => {
    const { orderId = "", type } = useParams();
    const { health } = useHealth();
    const allowFile = Boolean(health?.allowFileEvidence);

    const [order, setOrder] = useState<Order | null>(null);
    const [loadError, setLoadError] = useState<unknown>(null);
    const [step, setStep] = useState<Step>("scan");
    const [scannerKey, setScannerKey] = useState(0);
    const [scan, setScan] = useState<Scan | null>(null);
    const [scanning, setScanning] = useState(false);
    const [scanError, setScanError] = useState<unknown>(null);
    /** A label was read, but it belongs to something else than this order. */
    const [wrongCode, setWrongCode] = useState<string | null>(null);
    const [reason, setReason] = useState("");
    const [reasonMissing, setReasonMissing] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const [submitError, setSubmitError] = useState<unknown>(null);

    useEffect(() => {
        let cancelled = false;
        api.getOrder(orderId)
            .then((result) => {
                if (!cancelled) setOrder(result.order);
            })
            .catch((e: unknown) => {
                if (!cancelled) setLoadError(e);
            });
        return () => {
            cancelled = true;
        };
    }, [orderId]);

    if (type !== "outbound" && type !== "return") return <Navigate to={`/orders/${orderId}`} replace />;
    const backTo = `/orders/${encodeURIComponent(orderId)}`;
    const videoName = type === "outbound" ? "video đóng gói" : "video hoàn trả";

    const header = (
        <PageHeader
            title={`Thay ${videoName}`}
            subtitle="Quét lại nhãn của đơn này, ghi lý do rồi quay video mới."
            backTo={backTo}
        />
    );
    if (loadError)
        return (
            <>
                {header}
                <ErrorAlert error={loadError} />
            </>
        );
    if (!order)
        return (
            <div className="inline-loading">
                <Spinner />
            </div>
        );

    const onDetected = async (code: string, method: ScanMethod) => {
        setScanning(true);
        setScanError(null);
        try {
            const result = await api.scan(code, type === "outbound" ? "packing" : "return", method);
            if (result.scan.code !== order.trackingCode) {
                setWrongCode(code);
                return;
            }
            setScan(result.scan);
            setStep("video");
        } catch (e) {
            setScanError(e);
        } finally {
            setScanning(false);
        }
    };

    const rescan = () => {
        setScan(null);
        setWrongCode(null);
        setScanError(null);
        setSubmitError(null);
        setScannerKey((k) => k + 1);
        setStep("scan");
    };

    const finish = async (capture: Capture) => {
        if (!scan) return;
        const text = reason.trim();
        setReasonMissing(text.length < MIN_REASON);
        if (text.length < MIN_REASON) return;
        setSubmitting(true);
        setSubmitError(null);
        setProgress(0);
        try {
            await api.uploadEvidence(
                order.orderId,
                {
                    type,
                    scanId: scan.id,
                    file: capture.file,
                    captureMethod: capture.captureMethod,
                    recordingStartedAt: capture.recordingStartedAt,
                    recordingEndedAt: capture.recordingEndedAt,
                    replacementReason: text,
                },
                setProgress,
            );
            setStep("done");
        } catch (e) {
            setSubmitError(e);
        } finally {
            setSubmitting(false);
            setProgress(null);
        }
    };

    return (
        <div className="wizard">
            {header}
            <Stepper steps={STEPS} step={step} />

            {step === "scan" && (
                <Card title="Bước 1 · Quét mã vận đơn">
                    {wrongCode ? (
                        <div className="stack">
                            <Alert tone="warn" title={`Nhãn ${wrongCode} không phải của đơn này`}>
                                Hãy quét nhãn có mã vận đơn {order.trackingCode}.
                            </Alert>
                            <div className="row-actions">
                                <Button variant="primary" onClick={rescan}>
                                    Quét lại
                                </Button>
                            </div>
                        </div>
                    ) : scanning ? (
                        <div className="inline-loading">
                            <Spinner />
                            <span>Đang kiểm tra mã vận đơn…</span>
                        </div>
                    ) : scanError ? (
                        <div className="stack">
                            <ErrorAlert error={scanError} />
                            <div className="row-actions">
                                <Button variant="primary" onClick={rescan}>
                                    Quét lại
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <LabelScanner key={scannerKey} allowImage={allowFile} onDetected={onDetected} />
                    )}
                </Card>
            )}

            {step === "video" && (
                <Card title={`Bước 2 · Lý do và ${videoName} mới`}>
                    <div className="stack">
                        <div className="order-strip">
                            <span className="mono">{order.trackingCode}</span>
                            <span>
                                {order.orderId} · {order.product.name} · SL {order.expectedQuantity}
                            </span>
                        </div>
                        <Field label="Lý do thay video *" hint={`Bắt buộc, ít nhất ${MIN_REASON} ký tự.`}>
                            <textarea
                                rows={2}
                                maxLength={500}
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="Ví dụ: video cũ quá tối, không thấy rõ sản phẩm"
                            />
                        </Field>
                        {reasonMissing && <p className="form-error">Hãy nhập lý do thay video trước khi tải lên.</p>}
                        <VideoCapture
                            allowFile={allowFile}
                            onCaptured={finish}
                            busy={submitting}
                            confirmLabel="Thay bằng video này"
                        />
                        {progress !== null && <ProgressBar value={progress} />}
                        {submitError ? (
                            <>
                                <ErrorAlert error={submitError} />
                                <div className="row-actions">
                                    <Button onClick={rescan}>Quét lại nhãn</Button>
                                </div>
                            </>
                        ) : null}
                    </div>
                </Card>
            )}

            {step === "done" && (
                <Card>
                    <div className="done">
                        <span className="done-icon">
                            <IconCheck size={28} />
                        </span>
                        <h2>
                            Đã thay {videoName} cho đơn {order.orderId}
                        </h2>
                        <p className="result-sub">
                            Kết quả kiểm tra cũ vẫn dựa trên video trước. Mở đơn và bấm Kiểm tra lại để so sánh bằng
                            video mới.
                        </p>
                        <LinkButton to={backTo} variant="primary">
                            Xem đơn
                        </LinkButton>
                    </div>
                </Card>
            )}
        </div>
    );
};
