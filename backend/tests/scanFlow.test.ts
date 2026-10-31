import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { AuditLog } from "../src/models/AuditLog";
import { Order } from "../src/models/Order";
import { ScanSession } from "../src/models/ScanSession";
import { generateOrderId } from "../src/services/orderService";
import { connectTestDb, createOrder, createUser, disconnectTestDb, type TestUser } from "./helpers";

let owner: TestUser;
let employee: TestUser;
let colleague: TestUser;
let otherShop: TestUser;

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
    employee = await createUser({ role: "employee", shopId: "shop-a", warehouseIds: ["wh-1"] });
    colleague = await createUser({ role: "employee", shopId: "shop-a", warehouseIds: ["wh-1"] });
    otherShop = await createUser({ role: "owner", shopId: "shop-b" });
});
afterAll(disconnectTestDb);

const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });
const scan = (user: TestUser, code: string, purpose = "packing", method = "camera") =>
    request(app).post("/api/scans").set(auth(user)).send({ code, purpose, method });
const details = { warehouseId: "wh-1", product: { name: "Smart Watch", model: "SW-200" }, expectedQuantity: 1 };
const createFromScan = (user: TestUser, scanId: string, body: Record<string, unknown> = {}) =>
    request(app)
        .post("/api/orders")
        .set(auth(user))
        .send({ ...details, ...body, scanId });

const ORDER_ID = /^ORD-\d{6}-[2-9A-HJKMNP-Z]{4}$/;

describe("generateOrderId", () => {
    it("formats ORD-YYMMDD-XXXX from the local date and unambiguous characters", () => {
        expect(generateOrderId(new Date(2026, 9, 30, 8, 0), () => 0)).toBe("ORD-261030-2222");
        expect(generateOrderId()).toMatch(ORDER_ID);
    });
});

describe("POST /api/scans", () => {
    it("records a packing scan for a new tracking code", async () => {
        const res = await scan(employee, "GHN-NEW-1");
        expect(res.status).toBe(201);
        expect(res.body.data.order).toBeNull();
        expect(res.body.data.scan).toMatchObject({
            code: "GHN-NEW-1",
            purpose: "packing",
            method: "camera",
            manualEntry: false,
            orderId: null,
        });
        expect(new Date(res.body.data.scan.expiresAt).getTime()).toBeGreaterThan(Date.now());
        expect(await AuditLog.countDocuments({ action: "scan.record", actorId: employee.principal.userId })).toBe(1);
    });

    it("rejects values that are not tracking codes, unknown purposes and methods, and anonymous calls", async () => {
        expect((await scan(employee, "https://example.com/track?id=1")).status).toBe(400);
        expect((await scan(employee, "   ")).status).toBe(400);
        expect((await scan(employee, "GHN-1", "restock")).status).toBe(400);
        expect((await scan(employee, "GHN-1", "packing", "guess")).status).toBe(400);
        const anonymous = await request(app)
            .post("/api/scans")
            .send({ code: "GHN-1", purpose: "packing", method: "camera" });
        expect(anonymous.status).toBe(401);
    });

    it("returns the existing order on a packing scan of a known code, which cannot create a second order", async () => {
        await createOrder({ orderId: "ORD-TAKEN", trackingCode: "GHN-TAKEN", warehouseId: "wh-1" });
        await createOrder({ orderId: "ORD-TAKEN-2", trackingCode: "GHN-TAKEN-2", warehouseId: "wh-2" });
        const known = await scan(employee, "GHN-TAKEN");
        expect(known.status).toBe(201);
        expect(known.body.message).toMatch(/already exists/);
        expect(known.body.data.order.orderId).toBe("ORD-TAKEN");
        expect(known.body.data.scan).toMatchObject({ purpose: "packing", orderId: "ORD-TAKEN" });

        const second = await createFromScan(employee, known.body.data.scan.id);
        expect(second.status).toBe(409);
        expect(second.body.errors).toEqual([{ orderId: "ORD-TAKEN" }]);
        expect(await Order.countDocuments({ trackingCode: "GHN-TAKEN" })).toBe(1);

        expect((await scan(employee, "GHN-TAKEN-2")).status).toBe(403);
    });

    it("finds the order on a return scan, within the caller's shop and warehouses", async () => {
        await createOrder({
            orderId: "ORD-RET-1",
            trackingCode: "GHN-RET-1",
            warehouseId: "wh-1",
            customer: { name: "Tran Thi B", phone: "0901 000 111" },
        });
        await createOrder({ orderId: "ORD-RET-2", trackingCode: "GHN-RET-2", warehouseId: "wh-2" });

        const found = await scan(employee, "GHN-RET-1", "return", "hand_scanner");
        expect(found.status).toBe(201);
        expect(found.body.data.scan).toMatchObject({ purpose: "return", orderId: "ORD-RET-1" });
        expect(found.body.data.order.orderId).toBe("ORD-RET-1");
        expect(found.body.data.order.customer).toBeUndefined(); // customer data is for owners only
        expect((await scan(owner, "GHN-RET-1", "return")).body.data.order.customer.name).toBe("Tran Thi B");

        expect((await scan(employee, "GHN-RET-2", "return")).status).toBe(403);
        expect((await scan(otherShop, "GHN-RET-1", "return")).status).toBe(404);
        expect((await scan(employee, "GHN-UNKNOWN", "return")).status).toBe(404);
    });
});

describe("POST /api/orders from a packing scan", () => {
    it("uses the scanned tracking code and a generated order ID, ignoring client-supplied identifiers", async () => {
        const s = await scan(employee, "GHN-CREATE-1");
        const res = await createFromScan(employee, s.body.data.scan.id, {
            orderId: "ORD-CHOSEN",
            trackingCode: "GHN-OTHER",
        });
        expect(res.status).toBe(201);
        const order = res.body.data.order;
        expect(order.orderId).toMatch(ORDER_ID);
        expect(order.trackingCode).toBe("GHN-CREATE-1");
        expect(order.trackingScan).toMatchObject({ method: "camera", manualEntry: false });

        const stored = await ScanSession.findById(s.body.data.scan.id);
        expect(stored?.orderId).toBe(order.orderId);
        expect(stored?.orderCreatedAt).toBeInstanceOf(Date);
        expect(await AuditLog.countDocuments({ action: "order.create", orderId: order.orderId })).toBe(1);
    });

    it("marks orders whose tracking code was typed by hand", async () => {
        const s = await scan(employee, "GHN-MANUAL-1", "packing", "manual");
        expect(s.body.data.scan.manualEntry).toBe(true);
        const res = await createFromScan(employee, s.body.data.scan.id);
        expect(res.status).toBe(201);
        expect(res.body.data.order.trackingScan).toMatchObject({ method: "manual", manualEntry: true });
    });

    it("creates one order per packing scan, even under concurrent requests", async () => {
        const s = await scan(employee, "GHN-ONCE-1");
        const results = await Promise.all([
            createFromScan(employee, s.body.data.scan.id),
            createFromScan(employee, s.body.data.scan.id),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(await Order.countDocuments({ trackingCode: "GHN-ONCE-1" })).toBe(1);
    });

    it("rejects return scans, expired scans, other people's scans and unknown scans", async () => {
        await createOrder({ orderId: "ORD-RS", trackingCode: "GHN-RS", warehouseId: "wh-1" });
        const returnScan = await scan(employee, "GHN-RS", "return");
        const wrongPurpose = await createFromScan(employee, returnScan.body.data.scan.id);
        expect(wrongPurpose.status).toBe(409);
        expect(wrongPurpose.body.message).toMatch(/made for return/);

        const old = await scan(employee, "GHN-EXPIRED");
        await ScanSession.updateOne(
            { _id: old.body.data.scan.id },
            { $set: { expiresAt: new Date(Date.now() - 1000) } },
        );
        const expired = await createFromScan(employee, old.body.data.scan.id);
        expect(expired.status).toBe(409);
        expect(expired.body.message).toMatch(/expired/);

        const mine = await scan(employee, "GHN-MINE");
        expect((await createFromScan(colleague, mine.body.data.scan.id)).status).toBe(403);
        expect((await createFromScan(otherShop, mine.body.data.scan.id)).status).toBe(404);
        expect((await createFromScan(employee, "0123456789abcdef01234567")).status).toBe(404);
        expect((await createFromScan(employee, "not-an-id")).status).toBe(400);
    });

    it("refuses a code that got an order after the scan, and frees the scan when creation fails", async () => {
        const s = await scan(employee, "GHN-RACE-1");
        await createOrder({ orderId: "ORD-RACE", trackingCode: "GHN-RACE-1", warehouseId: "wh-1" });
        expect((await createFromScan(employee, s.body.data.scan.id)).status).toBe(409);

        const t = await scan(employee, "GHN-RETRY-1");
        expect((await createFromScan(employee, t.body.data.scan.id, { warehouseId: "wh-9" })).status).toBe(403);
        expect((await createFromScan(employee, t.body.data.scan.id)).status).toBe(201);
    });
});
