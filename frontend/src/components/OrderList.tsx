import { useEffect, useState } from "react";
import { api } from "../services/api";
import type { Order } from "../types";
import { Badge, ErrorText, Section, useAction } from "./common";

const STATUSES = ["", "none", "pending", "processing", "needs_review", "completed", "failed"];

export const OrderList = ({
    selected,
    onSelect,
    refreshKey,
}: {
    selected: string | null;
    onSelect: (orderId: string) => void;
    refreshKey: number;
}) => {
    const [orders, setOrders] = useState<Order[]>([]);
    const [status, setStatus] = useState("");
    const [search, setSearch] = useState("");
    const action = useAction();

    const load = () => action.run(async () => setOrders((await api.listOrders({ status, search })).orders));
    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, refreshKey]);

    return (
        <Section
            title={`Orders (${orders.length})`}
            actions={
                <button onClick={load} disabled={action.busy}>
                    {action.busy ? "Loading…" : "Refresh"}
                </button>
            }
        >
            <div className="row">
                <input
                    placeholder="Search order ID / tracking"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && load()}
                />
                <button onClick={load}>Search</button>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    {STATUSES.map((s) => (
                        <option key={s} value={s}>
                            {s || "all statuses"}
                        </option>
                    ))}
                </select>
            </div>
            <ErrorText error={action.error} />
            <table>
                <thead>
                    <tr>
                        <th>Order</th>
                        <th>Product</th>
                        <th>Status</th>
                        <th>Result</th>
                    </tr>
                </thead>
                <tbody>
                    {orders.map((o) => {
                        const latest = typeof o.latestInspectionId === "object" ? o.latestInspectionId : undefined;
                        return (
                            <tr
                                key={o._id}
                                className={selected === o.orderId ? "selected" : ""}
                                onClick={() => onSelect(o.orderId)}
                            >
                                <td>
                                    <b>{o.orderId}</b>
                                    <div className="muted small">{o.warehouseId}</div>
                                </td>
                                <td>{o.product.name}</td>
                                <td>
                                    <Badge value={o.inspectionStatus} />
                                </td>
                                <td className="small">{latest?.recommendedAction ?? "-"}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </Section>
    );
};
