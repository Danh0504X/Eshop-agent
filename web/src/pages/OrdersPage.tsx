import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IconBox, IconPlus, IconReturn } from "../components/icons";
import { EmptyState, ErrorAlert, LinkButton, PageHeader, Pill, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { formatDateTime, orderStatus } from "../lib/orderStatus";
import type { Order } from "../lib/types";

const SEARCH_DELAY_MS = 300;

export const OrdersPage = () => {
    const [search, setSearch] = useState("");
    const [orders, setOrders] = useState<Order[] | null>(null);
    const [error, setError] = useState<unknown>(null);

    useEffect(() => {
        let cancelled = false;
        const timer = window.setTimeout(() => {
            api.listOrders(search.trim())
                .then((result) => {
                    if (cancelled) return;
                    setOrders(result.orders);
                    setError(null);
                })
                .catch((e: unknown) => {
                    if (!cancelled) setError(e);
                });
        }, SEARCH_DELAY_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [search]);

    return (
        <>
            <PageHeader
                title="Đơn hàng"
                actions={
                    <>
                        <LinkButton to="/returns/new" icon={<IconReturn size={18} />}>
                            Nhận hàng hoàn
                        </LinkButton>
                        <LinkButton to="/orders/new" variant="primary" icon={<IconPlus size={18} />}>
                            Thêm đơn
                        </LinkButton>
                    </>
                }
            />
            <input
                className="orders-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm theo mã vận đơn hoặc mã đơn…"
                aria-label="Tìm đơn hàng"
            />
            <ErrorAlert error={error} />

            {orders === null && !error && (
                <div className="inline-loading">
                    <Spinner />
                </div>
            )}

            {orders?.length === 0 && (
                <div className="card">
                    <EmptyState
                        icon={<IconBox size={32} />}
                        title={search ? "Không tìm thấy đơn nào" : "Chưa có đơn hàng"}
                    >
                        {search ? "Hãy thử mã khác." : "Bấm Thêm đơn và quét nhãn vận đơn để tạo đơn đầu tiên."}
                    </EmptyState>
                </div>
            )}

            {orders && orders.length > 0 && (
                <div className="card order-list">
                    <div className="order-row order-row-head" aria-hidden="true">
                        <span>Mã vận đơn</span>
                        <span>Sản phẩm</span>
                        <span>Video</span>
                        <span>Trạng thái</span>
                        <span>Cập nhật</span>
                    </div>
                    {orders.map((order) => {
                        const status = orderStatus(order);
                        return (
                            <Link
                                key={order._id}
                                to={`/orders/${encodeURIComponent(order.orderId)}`}
                                className="order-row"
                            >
                                <span className="order-code">
                                    <span className="mono">{order.trackingCode}</span>
                                    <span className="order-sub">{order.orderId}</span>
                                </span>
                                <span className="order-product">
                                    {order.product.name}
                                    <span className="order-sub">SL {order.expectedQuantity}</span>
                                </span>
                                <span className="order-videos">
                                    <span className={order.packingMedia.length ? "has-video" : undefined}>
                                        Đóng gói
                                    </span>
                                    <span className={order.returnMedia.length ? "has-video" : undefined}>Hoàn trả</span>
                                </span>
                                <span>
                                    <Pill tone={status.tone}>{status.label}</Pill>
                                </span>
                                <span className="order-sub">{formatDateTime(order.updatedAt)}</span>
                            </Link>
                        );
                    })}
                </div>
            )}
        </>
    );
};
