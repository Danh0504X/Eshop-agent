import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { AuditLog } from "../src/models/AuditLog";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { Order } from "../src/models/Order";
import { connectTestDb, createOrder, createUser, disconnectTestDb, makeVideo, type TestUser } from "./helpers";

let owner: TestUser;
let employee: TestUser;
let otherShopOwner: TestUser;
let videoPath: string;

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a", email: "owner@shop-a.test" });
    employee = await createUser({ role: "employee", shopId: "shop-a", warehouseIds: ["wh-1"] });
    otherShopOwner = await createUser({ role: "owner", shopId: "shop-b" });
    videoPath = await makeVideo("normal");
});

afterAll(disconnectTestDb);

const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

describe("health and auth", () => {
    it("reports database and analysis mode", async () => {
        const res = await request(app).get("/api/health");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: "ok", analysisMode: "demo" });
    });

    it("logs in with valid credentials and rejects invalid ones", async () => {
        const ok = await request(app)
            .post("/api/auth/login")
            .send({ email: "owner@shop-a.test", password: "test-password" });
        expect(ok.status).toBe(200);
        expect(ok.body.data.token).toBeTypeOf("string");

        const bad = await request(app).post("/api/auth/login").send({ email: "owner@shop-a.test", password: "nope" });
        expect(bad.status).toBe(401);
        expect(await AuditLog.countDocuments({ action: "auth.login", outcome: "denied" })).toBe(1);
    });

    it("rejects requests without a token", async () => {
        expect((await request(app).get("/api/orders")).status).toBe(401);
    });
});

describe("orders", () => {
    const body = {
        orderId: "ORD-API-1",
        trackingCode: "TRK-API-1",
        warehouseId: "wh-1",
        product: { name: "Smart Watch", color: "silver" },
        expectedQuantity: 1,
        declaredValue: 199,
    };

    it("creates an order and validates input", async () => {
        const res = await request(app).post("/api/orders").set(auth(owner)).send(body);
        expect(res.status).toBe(201);
        expect(res.body.data.order.shopId).toBe("shop-a");

        const dup = await request(app).post("/api/orders").set(auth(owner)).send(body);
        expect(dup.status).toBe(409);

        const invalid = await request(app)
            .post("/api/orders")
            .set(auth(owner))
            .send({ ...body, orderId: "../etc" });
        expect(invalid.status).toBe(400);
        expect(invalid.body.code).toBe("VALIDATION_ERROR");
    });

    it("stops employees from creating orders outside their warehouses", async () => {
        const res = await request(app)
            .post("/api/orders")
            .set(auth(employee))
            .send({ ...body, orderId: "ORD-API-2", warehouseId: "wh-9" });
        expect(res.status).toBe(403);
    });

    it("isolates shops and warehouses", async () => {
        await createOrder({ orderId: "ORD-WH2", warehouseId: "wh-2" });

        const otherShop = await request(app).get("/api/orders/ORD-API-1").set(auth(otherShopOwner));
        expect(otherShop.status).toBe(404);
        const otherList = await request(app).get("/api/orders").set(auth(otherShopOwner));
        expect(otherList.body.data.orders).toHaveLength(0);

        const wrongWarehouse = await request(app).get("/api/orders/ORD-WH2").set(auth(employee));
        expect(wrongWarehouse.status).toBe(403);
        const employeeList = await request(app).get("/api/orders").set(auth(employee));
        expect(employeeList.body.data.orders.map((o: { orderId: string }) => o.orderId)).not.toContain("ORD-WH2");
    });
});

describe("evidence upload", () => {
    it("uploads, links, and refuses silent overwrites", async () => {
        await createOrder({ orderId: "ORD-MEDIA" });

        const first = await request(app)
            .post("/api/orders/ORD-MEDIA/media")
            .set(auth(employee))
            .field("type", "outbound")
            .attach("file", videoPath, { filename: "packing.mp4", contentType: "video/mp4" });
        expect(first.status).toBe(201);
        expect(first.body.data.media.status).toBe("linked");
        expect(first.body.data.media.storageKey).toBeUndefined();

        const again = await request(app)
            .post("/api/orders/ORD-MEDIA/media")
            .set(auth(employee))
            .field("type", "outbound")
            .attach("file", videoPath, { filename: "packing2.mp4", contentType: "video/mp4" });
        expect(again.status).toBe(409);

        const replaced = await request(app)
            .post("/api/orders/ORD-MEDIA/media")
            .set(auth(employee))
            .field("type", "outbound")
            .field("replaceExisting", "true")
            .field("replacementReason", "Original recording was cut off")
            .attach("file", videoPath, { filename: "packing3.mp4", contentType: "video/mp4" });
        expect(replaced.status).toBe(201);

        const old = await MediaEvidence.findById(first.body.data.media._id);
        expect(old?.status).toBe("superseded");
        const order = await Order.findOne({ orderId: "ORD-MEDIA" });
        expect(order?.packingMedia.map(String)).toEqual([replaced.body.data.media._id]);
        expect(await AuditLog.countDocuments({ action: "media.replace", orderId: "ORD-MEDIA" })).toBe(1);
    });

    it("rejects files whose content is not a video", async () => {
        await createOrder({ orderId: "ORD-FAKE" });
        const res = await request(app)
            .post("/api/orders/ORD-FAKE/media")
            .set(auth(owner))
            .field("type", "return")
            .attach("file", Buffer.from("definitely not a video file"), {
                filename: "x.mp4",
                contentType: "video/mp4",
            });
        expect(res.status).toBe(415);

        const wrongType = await request(app)
            .post("/api/orders/ORD-FAKE/media")
            .set(auth(owner))
            .field("type", "return")
            .attach("file", Buffer.from("#!/bin/sh"), { filename: "x.sh", contentType: "application/x-sh" });
        expect(wrongType.status).toBe(415);
    });

    it("requires owner role and explicit confirmation to delete evidence", async () => {
        const media = await MediaEvidence.findOne({ orderId: "ORD-MEDIA", status: "linked" });
        const asEmployee = await request(app)
            .delete(`/api/media/${media!.id}`)
            .set(auth(employee))
            .send({ reason: "cleanup", confirm: true });
        expect(asEmployee.status).toBe(403);

        const unconfirmed = await request(app)
            .delete(`/api/media/${media!.id}`)
            .set(auth(owner))
            .send({ reason: "cleanup" });
        expect(unconfirmed.status).toBe(400);

        const ok = await request(app)
            .delete(`/api/media/${media!.id}`)
            .set(auth(owner))
            .send({ reason: "uploaded by mistake", confirm: true });
        expect(ok.status).toBe(200);
        expect((await MediaEvidence.findById(media!.id))?.status).toBe("deleted");
    });
});
