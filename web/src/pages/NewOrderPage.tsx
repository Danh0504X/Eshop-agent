import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { IconCheck, IconPlus } from "../components/icons";
import { LabelScanner } from "../components/LabelScanner";
import { Alert, Button, Card, ErrorAlert, LinkButton, PageHeader, Pill, Spinner } from "../components/ui";
import { VideoCapture, type Capture } from "../components/VideoCapture";
import { ProgressBar, Stepper } from "../components/wizard";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useHealth } from "../lib/health";
import type { Media, Order, Scan, ScanMethod, User } from "../lib/types";

type Step = "scan" | "details" | "video" | "done";

const STEPS: Array<{ id: Exclude<Step, "done">; label: string }> = [
    { id: "scan", label: "Quét mã vận đơn" },
    { id: "details", label: "Thông tin đơn" },
    { id: "video", label: "Video đóng gói" },
];

interface Details {
    warehouseId: string;
    name: string;
    description: string;
    model: string;
    color: string;
    sku: string;
    quantity: string;
    accessories: string[];
    customerName: string;
    customerPhone: string;
    customerAddress: string;
}

const emptyDetails = (user: User | null): Details => ({
    warehouseId: user?.warehouseIds[0] ?? "",
    name: "",
    description: "",
    model: "",
    color: "",
    sku: "",
    quantity: "1",
    accessories: [],
    customerName: "",
    customerPhone: "",
    customerAddress: "",
});

const SCAN_LABEL: Record<ScanMethod, string> = {
    camera: "Đã quét",
    image_file: "Đọc từ ảnh (demo)",
    manual: "Nhập tay",
};

const optional = (value: string) => value.trim() || undefined;

/** Same rule as the backend's warehouseId. */
const WAREHOUSE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
    <label className="field">
        <span className="field-label">{label}</span>
        {children}
        {hint && <span className="field-hint">{hint}</span>}
    </label>
);

const AccessoriesInput = ({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) => {
    const [draft, setDraft] = useState("");
    const add = () => {
        const item = draft.trim().slice(0, 100);
        if (item && !value.includes(item)) onChange([...value, item]);
        setDraft("");
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
        }
    };
    return (
        <div className="field">
            <span className="field-label">Phụ kiện đi kèm</span>
            <div className="chips-input">
                {value.map((item) => (
                    <span key={item} className="chip">
                        {item}
                        <button
                            type="button"
                            aria-label={`Xóa ${item}`}
                            onClick={() => onChange(value.filter((x) => x !== item))}
                        >
                            ×
                        </button>
                    </span>
                ))}
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={add}
                    placeholder={value.length ? "Thêm phụ kiện…" : "Ví dụ: cáp sạc, túi đựng — nhấn Enter để thêm"}
                />
            </div>
        </div>
    );
};

const WarehouseField = ({
    user,
    value,
    onChange,
}: {
    user: User | null;
    value: string;
    onChange: (v: string) => void;
}) => {
    const warehouses = user?.warehouseIds ?? [];
    if (warehouses.length === 1)
        return (
            <div className="field">
                <span className="field-label">Kho</span>
                <p className="static-value">{warehouses[0]}</p>
            </div>
        );
    if (warehouses.length > 1)
        return (
            <Field label="Kho *">
                <select value={value} onChange={(e) => onChange(e.target.value)} required>
                    {warehouses.map((w) => (
                        <option key={w} value={w}>
                            {w}
                        </option>
                    ))}
                </select>
            </Field>
        );
    return (
        <Field label="Kho *" hint="Chữ không dấu, số và các ký tự . _ - (không có dấu cách).">
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Mã kho, ví dụ wh-hcm"
                required
            />
        </Field>
    );
};

/**
 * Add an order: scan the shipping label (the tracking code is filled in and locked), enter the order details,
 * then record the packing video. The order is created and the video uploaded at the end; the backend generates
 * the order ID. A label that already has an order without a packing video goes straight to recording one.
 */
export const NewOrderPage = () => {
    const { user } = useAuth();
    const { health } = useHealth();
    const allowFile = Boolean(health?.allowFileEvidence);

    const [step, setStep] = useState<Step>("scan");
    const [scannerKey, setScannerKey] = useState(0);
    const [scan, setScan] = useState<Scan | null>(null);
    const [scanning, setScanning] = useState(false);
    const [scanError, setScanError] = useState<unknown>(null);
    /** The order a packing scan found: its tracking code already has an order. */
    const [existing, setExisting] = useState<Order | null>(null);
    /** The order being completed: created here, or the existing one when adding its packing video. */
    const [order, setOrder] = useState<Order | null>(null);
    const [details, setDetails] = useState<Details>(() => emptyDetails(user));
    const [formError, setFormError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const [submitError, setSubmitError] = useState<unknown>(null);
    const [uploaded, setUploaded] = useState<Media | null>(null);

    const set = (key: keyof Details) => (e: { target: { value: string } }) =>
        setDetails((d) => ({ ...d, [key]: e.target.value }));

    const onDetected = async (code: string, method: ScanMethod) => {
        setScanning(true);
        setScanError(null);
        try {
            const result = await api.scan(code, "packing", method);
            setScan(result.scan);
            if (result.order) setExisting(result.order);
            else setStep("details");
        } catch (e) {
            setScanError(e);
        } finally {
            setScanning(false);
        }
    };

    const rescan = () => {
        setScan(null);
        setExisting(null);
        setOrder(null);
        setScanError(null);
        setSubmitError(null);
        setScannerKey((k) => k + 1);
        setStep("scan");
    };

    const startOver = () => {
        rescan();
        setUploaded(null);
        setDetails(emptyDetails(user));
    };

    const submitDetails = (e: FormEvent) => {
        e.preventDefault();
        // Catch these here, before the person spends time recording the video.
        const quantity = Number(details.quantity);
        let problem: string | null = null;
        if (!WAREHOUSE_ID.test(details.warehouseId.trim())) {
            problem = "Mã kho chỉ gồm chữ không dấu, số và các ký tự . _ - (không có dấu cách). Ví dụ: wh-hcm.";
        } else if (!details.name.trim()) {
            problem = "Tên sản phẩm không được để trống.";
        } else if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
            problem = "Số lượng phải là số nguyên từ 1 đến 10.000.";
        }
        setFormError(problem);
        if (!problem) setStep("video");
    };

    const finish = async (capture: Capture) => {
        if (!scan) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            let target = order;
            if (!target) {
                const customer = {
                    name: optional(details.customerName),
                    phone: optional(details.customerPhone),
                    address: optional(details.customerAddress),
                };
                const { order: created } = await api.createOrder({
                    scanId: scan.id,
                    warehouseId: details.warehouseId.trim(),
                    product: {
                        name: details.name.trim(),
                        description: optional(details.description),
                        model: optional(details.model),
                        color: optional(details.color),
                        sku: optional(details.sku),
                    },
                    expectedQuantity: Number(details.quantity),
                    expectedAccessories: details.accessories,
                    ...(Object.values(customer).some(Boolean) ? { customer } : {}),
                });
                target = created;
                setOrder(created);
            }
            setProgress(0);
            const { media } = await api.uploadEvidence(
                target.orderId,
                {
                    type: "outbound",
                    scanId: scan.id,
                    file: capture.file,
                    captureMethod: capture.captureMethod,
                    recordingStartedAt: capture.recordingStartedAt,
                    recordingEndedAt: capture.recordingEndedAt,
                },
                setProgress,
            );
            setUploaded(media);
            setStep("done");
        } catch (e) {
            setSubmitError(e);
        } finally {
            setSubmitting(false);
            setProgress(null);
        }
    };

    const addingToExisting = Boolean(existing && order && existing.orderId === order.orderId);

    return (
        <div className="wizard">
            <PageHeader
                title="Thêm đơn hàng"
                subtitle="Quét nhãn vận đơn, nhập thông tin rồi quay video đóng gói."
                backTo="/orders"
            />
            <Stepper steps={STEPS} step={step} skipped={addingToExisting ? "details" : undefined} />

            {step === "scan" && (
                <Card title="Bước 1 · Quét mã vận đơn">
                    {existing ? (
                        <div className="stack">
                            <Alert
                                tone="warn"
                                title={`Mã vận đơn ${existing.trackingCode} đã có đơn ${existing.orderId}`}
                            >
                                {existing.packingMedia.length
                                    ? "Đơn này đã có video đóng gói."
                                    : "Đơn này chưa có video đóng gói. Bạn có thể quay bổ sung ngay bây giờ."}
                            </Alert>
                            <div className="row-actions">
                                {!existing.packingMedia.length && (
                                    <Button
                                        variant="primary"
                                        onClick={() => {
                                            setOrder(existing);
                                            setStep("video");
                                        }}
                                    >
                                        Quay video đóng gói cho đơn này
                                    </Button>
                                )}
                                <LinkButton to={`/orders/${existing.orderId}`}>Mở đơn</LinkButton>
                                <Button variant="ghost" onClick={rescan}>
                                    Quét nhãn khác
                                </Button>
                            </div>
                        </div>
                    ) : scanning ? (
                        <div className="inline-loading">
                            <Spinner />
                            <span>Đang ghi nhận mã vận đơn…</span>
                        </div>
                    ) : (
                        <div className="stack">
                            {scanError ? (
                                <>
                                    <ErrorAlert error={scanError} />
                                    <div className="row-actions">
                                        <Button variant="primary" onClick={rescan}>
                                            Quét lại
                                        </Button>
                                    </div>
                                </>
                            ) : (
                                <LabelScanner key={scannerKey} allowImage={allowFile} onDetected={onDetected} />
                            )}
                        </div>
                    )}
                </Card>
            )}

            {step === "details" && scan && (
                <Card title="Bước 2 · Thông tin đơn hàng">
                    <form className="form" onSubmit={submitDetails}>
                        <div className="field">
                            <span className="field-label">Mã vận đơn</span>
                            <div className="locked-value">
                                <span className="mono">{scan.code}</span>
                                <Pill tone={scan.manualEntry ? "warn" : "ok"}>{SCAN_LABEL[scan.method]}</Pill>
                                <Button size="sm" variant="ghost" onClick={rescan}>
                                    Quét lại
                                </Button>
                            </div>
                            <span className="field-hint">Mã đơn hàng sẽ được hệ thống tự tạo.</span>
                        </div>

                        <WarehouseField
                            user={user}
                            value={details.warehouseId}
                            onChange={(warehouseId) => setDetails((d) => ({ ...d, warehouseId }))}
                        />

                        <p className="form-section-note">
                            Tên sản phẩm, số lượng và phụ kiện cho AI biết cần tìm gì khi so sánh video đóng gói với
                            video mở hàng hoàn.
                        </p>
                        <div className="form-grid">
                            <Field label="Tên sản phẩm *">
                                <input value={details.name} onChange={set("name")} required maxLength={200} />
                            </Field>
                            <Field label="Số lượng *">
                                <input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={10_000}
                                    value={details.quantity}
                                    onChange={set("quantity")}
                                    required
                                />
                            </Field>
                            <Field label="Model">
                                <input value={details.model} onChange={set("model")} maxLength={100} />
                            </Field>
                            <Field label="Màu sắc">
                                <input value={details.color} onChange={set("color")} maxLength={60} />
                            </Field>
                            <Field label="SKU">
                                <input value={details.sku} onChange={set("sku")} maxLength={100} />
                            </Field>
                        </div>
                        {formError && <p className="form-error">{formError}</p>}
                        <Field label="Mô tả">
                            <textarea
                                rows={2}
                                value={details.description}
                                onChange={set("description")}
                                maxLength={2000}
                            />
                        </Field>
                        <AccessoriesInput
                            value={details.accessories}
                            onChange={(accessories) => setDetails((d) => ({ ...d, accessories }))}
                        />
                        <details className="optional-section">
                            <summary>Thông tin khách hàng (không bắt buộc)</summary>
                            <p className="field-hint">
                                Chỉ chủ shop xem được. Không bao giờ gửi cho AI và được che trong báo cáo.
                            </p>
                            <div className="form-grid">
                                <Field label="Tên khách">
                                    <input
                                        value={details.customerName}
                                        onChange={set("customerName")}
                                        maxLength={200}
                                    />
                                </Field>
                                <Field label="Số điện thoại">
                                    <input
                                        value={details.customerPhone}
                                        onChange={set("customerPhone")}
                                        inputMode="tel"
                                        maxLength={40}
                                    />
                                </Field>
                            </div>
                            <Field label="Địa chỉ">
                                <input
                                    value={details.customerAddress}
                                    onChange={set("customerAddress")}
                                    maxLength={500}
                                />
                            </Field>
                        </details>
                        <div className="form-actions">
                            <Button type="submit" variant="primary" size="lg">
                                Tiếp tục: quay video đóng gói
                            </Button>
                        </div>
                    </form>
                </Card>
            )}

            {step === "video" && scan && (
                <Card title="Bước 3 · Quay video đóng gói">
                    <div className="stack">
                        <div className="order-strip">
                            <span className="mono">{scan.code}</span>
                            <span>
                                {addingToExisting && order
                                    ? `${order.orderId} · ${order.product.name}`
                                    : `${details.name} · SL ${details.quantity}`}
                            </span>
                        </div>
                        <p className="field-hint">
                            Quay liền mạch toàn bộ lúc đóng gói: cho thấy rõ sản phẩm, số lượng, phụ kiện và nhãn vận
                            đơn.
                        </p>
                        <VideoCapture
                            allowFile={allowFile}
                            onCaptured={finish}
                            busy={submitting}
                            confirmLabel={order ? "Tải video lên" : "Tạo đơn và tải video lên"}
                        />
                        {progress !== null && <ProgressBar value={progress} />}
                        {submitError ? (
                            <>
                                {order && !addingToExisting && (
                                    <Alert tone="info" title={`Đã tạo đơn ${order.orderId}`}>
                                        Video đóng gói chưa được tải lên. Hãy thử lại; nếu báo lỗi mã quét, quét lại
                                        nhãn.
                                    </Alert>
                                )}
                                <ErrorAlert error={submitError} />
                                <div className="row-actions">
                                    <Button onClick={rescan}>Quét lại nhãn</Button>
                                </div>
                            </>
                        ) : null}
                        {!order && !submitting && (
                            <div>
                                <Button variant="ghost" onClick={() => setStep("details")}>
                                    ← Sửa thông tin đơn
                                </Button>
                            </div>
                        )}
                    </div>
                </Card>
            )}

            {step === "done" && order && scan && (
                <Card>
                    <div className="done">
                        <span className="done-icon">
                            <IconCheck size={28} />
                        </span>
                        <h2>
                            {addingToExisting
                                ? `Đã thêm video đóng gói cho đơn ${order.orderId}`
                                : `Đã tạo đơn ${order.orderId}`}
                        </h2>
                        <dl className="meta-list">
                            <dt>Mã vận đơn</dt>
                            <dd>
                                <span className="mono">{order.trackingCode}</span>
                                {scan.manualEntry && <span className="muted"> (nhập tay)</span>}
                            </dd>
                            <dt>Sản phẩm</dt>
                            <dd>
                                {order.product.name} · SL {order.expectedQuantity}
                            </dd>
                            <dt>Video đóng gói</dt>
                            <dd>
                                {uploaded?.capture?.captureMethod === "file" ? "File từ máy (demo)" : "Quay trong app"}
                            </dd>
                        </dl>
                        <div className="row-actions">
                            <LinkButton to={`/orders/${order.orderId}`} variant="primary">
                                Xem đơn
                            </LinkButton>
                            <Button icon={<IconPlus size={18} />} onClick={startOver}>
                                Thêm đơn khác
                            </Button>
                        </div>
                    </div>
                </Card>
            )}
        </div>
    );
};
