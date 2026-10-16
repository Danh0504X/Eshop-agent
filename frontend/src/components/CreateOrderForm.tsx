import { useState, type FormEvent } from "react";
import { api } from "../services/api";
import { ErrorText, useAction } from "./common";

const EMPTY = {
    orderId: "",
    trackingCode: "",
    warehouseId: "",
    name: "",
    model: "",
    color: "",
    expectedQuantity: "1",
    accessories: "",
    declaredValue: "0",
    currency: "USD",
    customerName: "",
    customerPhone: "",
    customerAddress: "",
};

export const CreateOrderForm = ({
    defaultWarehouse,
    onCreated,
}: {
    defaultWarehouse: string;
    onCreated: (orderId: string) => void;
}) => {
    const [form, setForm] = useState({ ...EMPTY, warehouseId: defaultWarehouse });
    const action = useAction();
    const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
        setForm({ ...form, [key]: e.target.value });

    const submit = (e: FormEvent) => {
        e.preventDefault();
        void action.run(async () => {
            const customer = { name: form.customerName, phone: form.customerPhone, address: form.customerAddress };
            const { order } = await api.createOrder({
                orderId: form.orderId,
                trackingCode: form.trackingCode,
                warehouseId: form.warehouseId,
                product: { name: form.name, model: form.model || undefined, color: form.color || undefined },
                expectedQuantity: Number(form.expectedQuantity),
                expectedAccessories: form.accessories
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                declaredValue: Number(form.declaredValue),
                currency: form.currency,
                ...(Object.values(customer).some(Boolean) ? { customer } : {}),
            });
            setForm({ ...EMPTY, warehouseId: defaultWarehouse });
            onCreated(order.orderId);
        });
    };

    return (
        <form className="grid-form" onSubmit={submit}>
            <input placeholder="Order ID *" value={form.orderId} onChange={set("orderId")} required />
            <input placeholder="Tracking code *" value={form.trackingCode} onChange={set("trackingCode")} required />
            <input placeholder="Warehouse ID *" value={form.warehouseId} onChange={set("warehouseId")} required />
            <input placeholder="Product name *" value={form.name} onChange={set("name")} required />
            <input placeholder="Model" value={form.model} onChange={set("model")} />
            <input placeholder="Colour" value={form.color} onChange={set("color")} />
            <label>
                Quantity
                <input
                    type="number"
                    min={1}
                    value={form.expectedQuantity}
                    onChange={set("expectedQuantity")}
                    required
                />
            </label>
            <label>
                Declared value
                <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.declaredValue}
                    onChange={set("declaredValue")}
                    required
                />
            </label>
            <input placeholder="Currency" value={form.currency} onChange={set("currency")} maxLength={3} />
            <input placeholder="Accessories (comma separated)" value={form.accessories} onChange={set("accessories")} />
            <input placeholder="Customer name (optional)" value={form.customerName} onChange={set("customerName")} />
            <input placeholder="Customer phone (optional)" value={form.customerPhone} onChange={set("customerPhone")} />
            <input
                placeholder="Customer address (optional)"
                value={form.customerAddress}
                onChange={set("customerAddress")}
            />
            <button type="submit" className="primary" disabled={action.busy}>
                {action.busy ? "Creating…" : "Create order"}
            </button>
            <ErrorText error={action.error} />
        </form>
    );
};
