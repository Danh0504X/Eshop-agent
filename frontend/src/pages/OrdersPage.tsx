import { useEffect, useState } from "react";
import { ClaimPanel } from "../components/ClaimPanel";
import { Badge, ErrorText, Section, useAction } from "../components/common";
import { CreateOrderForm } from "../components/CreateOrderForm";
import { EvidencePanel } from "../components/EvidencePanel";
import { InspectionPanel } from "../components/InspectionPanel";
import { OrderList } from "../components/OrderList";
import { api } from "../services/api";
import type { Order, User } from "../types";

const OrderInfo = ({ order }: { order: Order }) => (
    <table>
        <tbody>
            <tr>
                <td>Order / tracking</td>
                <td>
                    {order.orderId} / {order.trackingCode}
                    {order.trackingScan?.manualEntry && <span className="muted small"> (typed by hand)</span>}
                </td>
            </tr>
            <tr>
                <td>Warehouse</td>
                <td>{order.warehouseId}</td>
            </tr>
            <tr>
                <td>Product</td>
                <td>
                    {[order.product.name, order.product.model, order.product.color, order.product.sku]
                        .filter(Boolean)
                        .join(" · ")}
                </td>
            </tr>
            <tr>
                <td>Expected</td>
                <td>
                    {order.expectedQuantity} item(s); accessories: {order.expectedAccessories.join(", ") || "none"}
                </td>
            </tr>
            {order.customer && (
                <tr>
                    <td>Customer (owner only)</td>
                    <td>
                        {[order.customer.name, order.customer.phone, order.customer.address]
                            .filter(Boolean)
                            .join(" · ")}
                    </td>
                </tr>
            )}
            <tr>
                <td>Inspection status</td>
                <td>
                    <Badge value={order.inspectionStatus} />
                </td>
            </tr>
        </tbody>
    </table>
);

export const OrdersPage = ({ user }: { user: User }) => {
    const [selected, setSelected] = useState<string | null>(null);
    const [order, setOrder] = useState<Order | null>(null);
    const [claimId, setClaimId] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [showCreate, setShowCreate] = useState(false);
    const action = useAction();

    const loadOrder = (orderId: string) =>
        action.run(async () => {
            const { order } = await api.getOrder(orderId);
            setOrder(order);
            setClaimId(order.latestClaimId ?? null);
        });

    useEffect(() => {
        if (selected) void loadOrder(selected);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected]);

    const changed = () => {
        setRefreshKey((k) => k + 1);
        if (selected) void loadOrder(selected);
    };

    return (
        <div className="layout">
            <div className="stack">
                <Section
                    title="New order"
                    actions={
                        <button onClick={() => setShowCreate(!showCreate)}>
                            {showCreate ? "Hide" : "Create order"}
                        </button>
                    }
                >
                    {showCreate && (
                        <CreateOrderForm
                            defaultWarehouse={user.warehouseIds[0] ?? ""}
                            onCreated={(id) => {
                                setShowCreate(false);
                                setRefreshKey((k) => k + 1);
                                setSelected(id);
                            }}
                        />
                    )}
                </Section>
                <OrderList selected={selected} onSelect={setSelected} refreshKey={refreshKey} />
            </div>

            <div className="stack">
                {!selected && (
                    <p className="muted card">
                        Select an order to upload evidence, run an inspection and review claims.
                    </p>
                )}
                <ErrorText error={action.error} />
                {order && selected === order.orderId && (
                    <>
                        <Section
                            title={`Order ${order.orderId}`}
                            actions={<button onClick={() => loadOrder(order.orderId)}>Refresh</button>}
                        >
                            <OrderInfo order={order} />
                        </Section>
                        <EvidencePanel orderId={order.orderId} user={user} onChanged={changed} />
                        <InspectionPanel orderId={order.orderId} onChanged={changed} onOpenClaim={setClaimId} />
                        {claimId && <ClaimPanel claimId={claimId} user={user} onChanged={changed} />}
                    </>
                )}
            </div>
        </div>
    );
};
