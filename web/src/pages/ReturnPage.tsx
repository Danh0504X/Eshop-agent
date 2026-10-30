import { useState } from "react";
import { IconCheck, IconReturn } from "../components/icons";
import { LabelScanner } from "../components/LabelScanner";
import { Alert, Button, Card, ErrorAlert, LinkButton, PageHeader, Spinner } from "../components/ui";
import { VideoCapture, type Capture } from "../components/VideoCapture";
import { ProgressBar, Stepper } from "../components/wizard";
import { api, ApiError } from "../lib/api";
import { useHealth } from "../lib/health";
import type { Order, Scan, ScanMethod } from "../lib/types";

type Step = "scan" | "video" | "done";

const STEPS = [
    { id: "scan", label: "Quét mã vận đơn" },
    { id: "video", label: "Video hoàn trả" },
];

/**
 * Receive a return: scan the label to find its order, then record the opening video. A code without an order
 * is reported; an order that already has a return video links to the order instead.
 */
export const ReturnPage = () => {
    const { health } = useHealth();
    const allowFile = Boolean(health?.allowFileEvidence);

    const [step, setStep] = useState<Step>("scan");
    const [scannerKey, setScannerKey] = useState(0);
    const [scan, setScan] = useState<Scan | null>(null);
    const [order, setOrder] = useState<Order | null>(null);
    const [lastCode, setLastCode] = useState("");
    const [scanning, setScanning] = useState(false);
    const [scanError, setScanError] = useState<unknown>(null);
    const [submitting, setSubmitting] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const [submitError, setSubmitError] = useState<unknown>(null);

    const onDetected = async (code: string, method: ScanMethod) => {
        setLastCode(code);
        setScanning(true);
        setScanError(null);
        try {
            const result = await api.scan(code, "return", method);
            setScan(result.scan);
            setOrder(result.order);
            if (result.order && !result.order.returnMedia.length) setStep("video");
        } catch (e) {
            setScanError(e);
        } finally {
            setScanning(false);
        }
    };

    const rescan = () => {
        setScan(null);
        setOrder(null);
        setScanError(null);
        setSubmitError(null);
        setScannerKey((k) => k + 1);
        setStep("scan");
    };

    const finish = async (capture: Capture) => {
        if (!scan || !order) return;
        setSubmitting(true);
        setSubmitError(null);
        setProgress(0);
        try {
            await api.uploadEvidence(
                order.orderId,
                {
                    type: "return",
                    scanId: scan.id,
                    file: capture.file,
                    captureMethod: capture.captureMethod,
                    recordingStartedAt: capture.recordingStartedAt,
                    recordingEndedAt: capture.recordingEndedAt,
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

    const notFound = scanError instanceof ApiError && scanError.status === 404;

    return (
        <div className="wizard">
            <PageHeader
                title="Nhận hàng hoàn"
                subtitle="Quét nhãn vận đơn của kiện hàng hoàn rồi quay video mở hàng."
                backTo="/orders"
            />
            <Stepper steps={STEPS} step={step} />

            {step === "scan" && (
                <Card title="Bước 1 · Quét mã vận đơn">
                    {order ? (
                        <div className="stack">
                            <Alert tone="warn" title={`Đơn ${order.orderId} đã có video hoàn trả`}>
                                Mã vận đơn {order.trackingCode}. Mở đơn để xem lại video.
                            </Alert>
                            <div className="row-actions">
                                <LinkButton to={`/orders/${encodeURIComponent(order.orderId)}`} variant="primary">
                                    Mở đơn
                                </LinkButton>
                                <Button variant="ghost" onClick={rescan}>
                                    Quét nhãn khác
                                </Button>
                            </div>
                        </div>
                    ) : scanning ? (
                        <div className="inline-loading">
                            <Spinner />
                            <span>Đang tìm đơn hàng…</span>
                        </div>
                    ) : scanError ? (
                        <div className="stack">
                            {notFound ? (
                                <Alert tone="warn" title={`Không tìm thấy đơn hàng với mã ${lastCode}`}>
                                    Mã này chưa có đơn trong hệ thống. Hãy kiểm tra lại nhãn hoặc quét lại.
                                </Alert>
                            ) : (
                                <ErrorAlert error={scanError} />
                            )}
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

            {step === "video" && order && (
                <Card title="Bước 2 · Quay video mở hàng hoàn">
                    <div className="stack">
                        <div className="order-strip">
                            <span className="mono">{order.trackingCode}</span>
                            <span>
                                {order.orderId} · {order.product.name} · SL {order.expectedQuantity}
                            </span>
                        </div>
                        {!order.packingMedia.length && (
                            <Alert tone="warn" title="Đơn này chưa có video đóng gói">
                                Vẫn lưu được video hoàn trả, nhưng cần có cả hai video mới so sánh được.
                            </Alert>
                        )}
                        <p className="field-hint">
                            Quay liền mạch từ lúc mở kiện: cho thấy rõ sản phẩm, số lượng, phụ kiện và tình trạng hàng.
                        </p>
                        <VideoCapture
                            allowFile={allowFile}
                            onCaptured={finish}
                            busy={submitting}
                            confirmLabel="Tải video hoàn trả lên"
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

            {step === "done" && order && (
                <Card>
                    <div className="done">
                        <span className="done-icon">
                            <IconCheck size={28} />
                        </span>
                        <h2>Đã lưu video hoàn trả cho đơn {order.orderId}</h2>
                        <dl className="meta-list">
                            <dt>Mã vận đơn</dt>
                            <dd className="mono">{order.trackingCode}</dd>
                            <dt>Sản phẩm</dt>
                            <dd>
                                {order.product.name} · SL {order.expectedQuantity}
                            </dd>
                        </dl>
                        <div className="row-actions">
                            <LinkButton to={`/orders/${encodeURIComponent(order.orderId)}`} variant="primary">
                                Xem đơn
                            </LinkButton>
                            <Button icon={<IconReturn size={18} />} onClick={rescan}>
                                Nhận đơn khác
                            </Button>
                        </div>
                    </div>
                </Card>
            )}
        </div>
    );
};
