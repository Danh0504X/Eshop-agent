import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { AuthVideo } from "../components/AuthVideo";
import { IconReturn } from "../components/icons";
import { Card, EmptyState, ErrorAlert, LinkButton, PageHeader, Pill, Spinner } from "../components/ui";
import { formatDuration, formatSize } from "../components/VideoCapture";
import { api } from "../lib/api";
import { formatDateTime, orderStatus } from "../lib/orderStatus";
import type { Media, Order, ScanMethod } from "../lib/types";

const SCAN_LABEL: Record<ScanMethod, string> = {
    camera: "quét bằng camera",
    image_file: "đọc từ ảnh (demo)",
    manual: "nhập tay",
};

const EvidenceCard = ({
    title,
    media,
    missingText,
    action,
}: {
    title: string;
    media?: Media;
    missingText: string;
    action: ReactNode;
}) => (
    <Card title={title}>
        {media ? (
            <div className="stack">
                <AuthVideo src={media.fileUrl} />
                <p className="evidence-meta">
                    {media.capture?.captureMethod === "recorded" ? "Quay trong app" : "File từ máy"}
                    {media.metadata?.durationSec !== undefined &&
                        ` · ${formatDuration(media.metadata.durationSec)}`} · {formatSize(media.sizeBytes)} ·{" "}
                    {formatDateTime(media.uploadedAt)}
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

export const OrderDetailPage = () => {
    const { orderId = "" } = useParams();
    const [order, setOrder] = useState<Order | null>(null);
    const [media, setMedia] = useState<Media[]>([]);
    const [error, setError] = useState<unknown>(null);

    useEffect(() => {
        let cancelled = false;
        setOrder(null);
        setError(null);
        Promise.all([api.getOrder(orderId), api.listMedia(orderId)])
            .then(([orderResult, mediaResult]) => {
                if (cancelled) return;
                setOrder(orderResult.order);
                setMedia(mediaResult.media);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(e);
            });
        return () => {
            cancelled = true;
        };
    }, [orderId]);

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
    return (
        <>
            <PageHeader
                backTo="/orders"
                title={<span className="mono">{order.trackingCode}</span>}
                subtitle={`Đơn ${order.orderId}`}
                actions={<Pill tone={status.tone}>{status.label}</Pill>}
            />
            <div className="order-detail">
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
                        media={media.find((m) => m.type === "outbound")}
                        missingText="Quét lại nhãn ở màn hình Thêm đơn để quay bổ sung."
                        action={<LinkButton to="/orders/new">Quay video đóng gói</LinkButton>}
                    />
                    <EvidenceCard
                        title="Video hoàn trả"
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
