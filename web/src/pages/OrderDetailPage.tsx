import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { AuthVideo } from "../components/AuthVideo";
import { ClaimRow, ClaimRowHead } from "../components/ClaimRow";
import { IconReturn } from "../components/icons";
import { InspectionCard } from "../components/InspectionCard";
import { Button, Card, EmptyState, ErrorAlert, Field, LinkButton, PageHeader, Pill, Spinner } from "../components/ui";
import { formatDuration, formatSize } from "../components/VideoCapture";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime, orderStatus } from "../lib/orderStatus";
import type { Claim, Media, Order, ScanMethod } from "../lib/types";

const SCAN_LABEL: Record<ScanMethod, string> = {
    camera: "quét bằng camera",
    image_file: "đọc từ ảnh (demo)",
    manual: "nhập tay",
};

const MIN_REASON = 5;

/** Owner only. The backend removes the file for good, so it asks for a reason first. */
const DeleteEvidence = ({ media, onDeleted }: { media: Media; onDeleted: () => void }) => {
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const text = reason.trim();

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.deleteMedia(media._id, text);
            onDeleted();
        } catch (e) {
            setError(e);
            setBusy(false);
        }
    };

    return (
        <div className="stack delete-evidence">
            <Field
                label="Lý do xóa *"
                hint={`Video bị xóa vĩnh viễn, không khôi phục được. Lý do cần ít nhất ${MIN_REASON} ký tự.`}
            >
                <input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <ErrorAlert error={error} />
            <div className="row-actions">
                <Button variant="danger" busy={busy} disabled={text.length < MIN_REASON} onClick={remove}>
                    Xóa vĩnh viễn
                </Button>
            </div>
        </div>
    );
};

const EvidenceCard = ({
    title,
    orderId,
    media,
    missingText,
    action,
    onDeleted,
}: {
    title: string;
    orderId: string;
    media?: Media;
    missingText: string;
    action: ReactNode;
    onDeleted: () => void;
}) => {
    const { user } = useAuth();
    const [deleting, setDeleting] = useState(false);
    return (
        <Card
            title={title}
            actions={
                media && (
                    <>
                        <LinkButton size="sm" to={`/orders/${encodeURIComponent(orderId)}/replace/${media.type}`}>
                            Thay video
                        </LinkButton>
                        {user?.role === "owner" && (
                            <Button size="sm" variant="ghost" onClick={() => setDeleting((d) => !d)}>
                                {deleting ? "Không xóa" : "Xóa"}
                            </Button>
                        )}
                    </>
                )
            }
        >
            {media ? (
                <div className="stack">
                    {deleting && (
                        <DeleteEvidence
                            media={media}
                            onDeleted={() => {
                                setDeleting(false);
                                onDeleted();
                            }}
                        />
                    )}
                    <AuthVideo src={media.fileUrl} />
                    <p className="evidence-meta">
                        {media.capture?.captureMethod === "recorded" ? "Quay trong app" : "File từ máy"}
                        {media.metadata?.durationSec !== undefined &&
                            ` · ${formatDuration(media.metadata.durationSec)}`}{" "}
                        · {formatSize(media.sizeBytes)} · {formatDateTime(media.uploadedAt)}
                    </p>
                    {media.capture && (
                        <p className="evidence-meta">Mã vận đơn: {SCAN_LABEL[media.capture.scanMethod] ?? "đã quét"}</p>
                    )}
                </div>
            ) : (
                <EmptyState title="Chưa có video" action={action}>
                    {missingText}
                </EmptyState>
            )}
        </Card>
    );
};

export const OrderDetailPage = () => {
    const { orderId = "" } = useParams();
    const [order, setOrder] = useState<Order | null>(null);
    const [media, setMedia] = useState<Media[]>([]);
    const [claims, setClaims] = useState<Claim[]>([]);
    const [error, setError] = useState<unknown>(null);

    const load = useCallback(
        async (isCurrent: () => boolean) => {
            const [orderResult, mediaResult, claimResult] = await Promise.all([
                api.getOrder(orderId),
                api.listMedia(orderId),
                api.listClaims({ orderId }),
            ]);
            if (!isCurrent()) return;
            setOrder(orderResult.order);
            setMedia(mediaResult.media);
            setClaims(claimResult.claims);
        },
        [orderId],
    );

    useEffect(() => {
        let cancelled = false;
        setOrder(null);
        setError(null);
        load(() => !cancelled).catch((e: unknown) => {
            if (!cancelled) setError(e);
        });
        return () => {
            cancelled = true;
        };
    }, [load]);

    /** After an inspection or a deleted video. What is on screen stays if this fails; it is only an update. */
    const refresh = () => void load(() => true).catch(() => undefined);

    if (error)
        return (
            <>
                <PageHeader title="Chi tiết đơn" backTo="/orders" />
                <ErrorAlert error={error} />
            </>
        );
    if (!order)
        return (
            <div className="inline-loading">
                <Spinner />
            </div>
        );

    const status = orderStatus(order);
    const product = order.product;
    const latest = order.latestInspectionId;
    return (
        <>
            <PageHeader
                backTo="/orders"
                title={<span className="mono">{order.trackingCode}</span>}
                subtitle={`Đơn ${order.orderId}`}
                actions={<Pill tone={status.tone}>{status.label}</Pill>}
            />
            <div className="order-detail">
                <InspectionCard
                    key={order.orderId}
                    orderId={order.orderId}
                    initialInspectionId={typeof latest === "object" ? latest._id : latest}
                    ready={order.packingMedia.length > 0 && order.returnMedia.length > 0}
                    onChanged={refresh}
                />
                {claims.length > 0 && (
                    <Card title="Khiếu nại của đơn" className="order-claims">
                        <ClaimRowHead />
                        {claims.map((claim) => (
                            <ClaimRow key={claim._id} claim={claim} />
                        ))}
                    </Card>
                )}
                <Card title="Thông tin đơn">
                    <dl className="meta-list">
                        <dt>Sản phẩm</dt>
                        <dd>{product.name}</dd>
                        {product.description && (
                            <>
                                <dt>Mô tả</dt>
                                <dd>{product.description}</dd>
                            </>
                        )}
                        {product.model && (
                            <>
                                <dt>Model</dt>
                                <dd>{product.model}</dd>
                            </>
                        )}
                        {product.color && (
                            <>
                                <dt>Màu sắc</dt>
                                <dd>{product.color}</dd>
                            </>
                        )}
                        {product.sku && (
                            <>
                                <dt>SKU</dt>
                                <dd>{product.sku}</dd>
                            </>
                        )}
                        <dt>Số lượng</dt>
                        <dd>{order.expectedQuantity}</dd>
                        <dt>Phụ kiện</dt>
                        <dd>{order.expectedAccessories.join(", ") || "Không có"}</dd>
                        <dt>Kho</dt>
                        <dd>{order.warehouseId}</dd>
                        <dt>Mã vận đơn</dt>
                        <dd>
                            {order.trackingCode}
                            {order.trackingScan?.manualEntry && <span className="muted"> (nhập tay)</span>}
                        </dd>
                        <dt>Ngày tạo</dt>
                        <dd>{formatDateTime(order.createdAt)}</dd>
                        {order.customer && Object.values(order.customer).some(Boolean) && (
                            <>
                                <dt>Khách hàng</dt>
                                <dd>
                                    {[order.customer.name, order.customer.phone, order.customer.address]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </dd>
                            </>
                        )}
                    </dl>
                </Card>
                <div className="evidence-grid">
                    <EvidenceCard
                        title="Video đóng gói"
                        orderId={order.orderId}
                        onDeleted={refresh}
                        media={media.find((m) => m.type === "outbound")}
                        missingText="Quét lại nhãn ở màn hình Thêm đơn để quay bổ sung."
                        action={<LinkButton to="/orders/new">Quay video đóng gói</LinkButton>}
                    />
                    <EvidenceCard
                        title="Video hoàn trả"
                        orderId={order.orderId}
                        onDeleted={refresh}
                        media={media.find((m) => m.type === "return")}
                        missingText="Khi nhận hàng hoàn, quét nhãn của đơn này rồi quay video mở hàng."
                        action={
                            <LinkButton to="/returns/new" variant="primary" icon={<IconReturn size={18} />}>
                                Nhận hàng hoàn
                            </LinkButton>
                        }
                    />
                </div>
            </div>
        </>
    );
};
