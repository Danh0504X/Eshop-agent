import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { env, overrideEnv } from "../src/config/env";
import { AuditLog } from "../src/models/AuditLog";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import { Order } from "../src/models/Order";
import { inspectionQueue, InspectionQueue, recoverInterruptedInspections } from "../src/services/inspectionQueue";
import { setVisionProvider } from "../src/services/vision";
import {
    connectTestDb,
    createMediaFromFile,
    createOrder,
    createUser,
    disconnectTestDb,
    makeVideo,
    type TestUser,
} from "./helpers";

let owner: TestUser;
let employee: TestUser;
let otherShop: TestUser;
const defaultLimit = env.RATE_LIMIT_INSPECTIONS_PER_15MIN;

beforeAll(async () => {
    await connectTestDb();
    setVisionProvider(undefined); // demo mode -> DemoVisionProvider
    owner = await createUser({ role: "owner", shopId: "shop-a" });
    employee = await createUser({ role: "employee", shopId: "shop-a", warehouseIds: ["wh-1"] });
    otherShop = await createUser({ role: "owner", shopId: "shop-b" });
});
afterAll(async () => {
    await inspectionQueue.onIdle();
    await disconnectTestDb();
});
afterEach(async () => {
    inspectionQueue.resume();
    await inspectionQueue.onIdle();
    overrideEnv({ RATE_LIMIT_INSPECTIONS_PER_15MIN: defaultLimit });
});

const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

let seq = 0;
const orderWithEvidence = async (opts: { scenario?: string; withReturn?: boolean; warehouseId?: string } = {}) => {
    seq++;
    const order = await createOrder({
        orderId: `ORD-API-${seq}`,
        trackingCode: `TRK-API-${seq}`,
        demoScenario: opts.scenario ?? "normal",
        warehouseId: opts.warehouseId ?? "wh-1",
    });
    await createMediaFromFile(order, "outbound", await makeVideo("normal"), owner.principal.userId);
    if (opts.withReturn !== false) {
        await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
    }
    return order;
};

const poll = async (id: string, user: TestUser = owner) => {
    await inspectionQueue.onIdle();
    const res = await request(app).get(`/api/inspections/${id}`).set(auth(user));
    expect(res.status).toBe(200);
    return res.body.data.inspection;
};

describe("POST /api/orders/:orderId/inspect", () => {
    it("queues the inspection, returns 202 immediately, and exposes the result for polling", async () => {
        const order = await orderWithEvidence({ scenario: "mismatch" });
        inspectionQueue.pause();
        const res = await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(employee));

        expect(res.status).toBe(202);
        expect(res.headers.location).toBe(`/api/inspections/${res.body.data.inspection._id}`);
        expect(res.body.data.inspection).toMatchObject({
            status: "pending",
            analysisMode: "demo" as const,
            planner: "deterministic" as const,
        });
        expect((await Order.findById(order._id))?.inspectionStatus).toBe("pending");

        inspectionQueue.resume();
        const done = await poll(res.body.data.inspection._id, employee);
        expect(done.status).toBe("completed");
        expect(done.claimId).toBeDefined();
        expect(done.frameReferences[0].imageUrl).toMatch(/^\/api\/media\/[a-f0-9]{24}\/frames\/(OUT|RET)-\d{2}$/);
        expect(await AuditLog.countDocuments({ action: "inspection.start", orderId: order.orderId })).toBe(1);

        // Cited frame images are served to authorized users.
        const frame = await request(app).get(done.frameReferences[0].imageUrl).set(auth(employee));
        expect(frame.status).toBe(200);
        expect(frame.headers["content-type"]).toBe("image/jpeg");

        const list = await request(app).get(`/api/orders/${order.orderId}/inspections`).set(auth(owner));
        expect(list.body.data.inspections).toHaveLength(1);
    });

    it("rejects a second inspection while one is running", async () => {
        const order = await orderWithEvidence();
        inspectionQueue.pause();
        expect((await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(owner))).status).toBe(202);
        const second = await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(owner));
        expect(second.status).toBe(409);
        expect(second.body.code).toBe("CONFLICT");
    });

    it("enforces shop and warehouse boundaries", async () => {
        const order = await orderWithEvidence({ warehouseId: "wh-2" });
        expect((await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(employee))).status).toBe(403);
        expect((await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(otherShop))).status).toBe(404);

        const own = await orderWithEvidence();
        const res = await request(app).post(`/api/orders/${own.orderId}/inspect`).set(auth(owner));
        await inspectionQueue.onIdle();
        const id = res.body.data.inspection._id;
        expect((await request(app).get(`/api/inspections/${id}`).set(auth(otherShop))).status).toBe(404);
        expect((await request(app).get(`/api/inspections/not-an-id`).set(auth(owner))).status).toBe(400);
    });
});

describe("POST /api/inspections/:id/retry", () => {
    it("lets a reviewer upload missing evidence and rerun to completion", async () => {
        const order = await orderWithEvidence({ withReturn: false });
        const start = await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(employee));
        const id = start.body.data.inspection._id;
        const escalated = await poll(id);
        expect(escalated.status).toBe("needs_review");
        expect(escalated.reviewTask.status).toBe("open");

        const upload = await request(app)
            .post(`/api/orders/${order.orderId}/media`)
            .set(auth(employee))
            .field("type", "return")
            .attach("file", await makeVideo("normal"), { filename: "return.mp4", contentType: "video/mp4" });
        expect(upload.status).toBe(201);

        const retry = await request(app).post(`/api/inspections/${id}/retry`).set(auth(employee));
        expect(retry.status).toBe(202);
        expect(retry.body.data.inspection).toMatchObject({ status: "pending", attempt: 2 });

        const done = await poll(id);
        expect(done.status).toBe("completed");
        expect(done.attempt).toBe(2);
        expect(done.reviewTask.status).toBe("resolved");
        expect(done.escalation.required).toBe(false);
        expect(done.agentLog.some((l: { attempt: number }) => l.attempt === 1)).toBe(true);
        expect(await AuditLog.countDocuments({ action: "inspection.retry", inspectionId: id })).toBe(1);
    });

    it("refuses to retry completed inspections or ones with an undecided draft claim", async () => {
        const normal = await orderWithEvidence();
        const a = await request(app).post(`/api/orders/${normal.orderId}/inspect`).set(auth(owner));
        await poll(a.body.data.inspection._id);
        const completed = await request(app)
            .post(`/api/inspections/${a.body.data.inspection._id}/retry`)
            .set(auth(owner));
        expect(completed.status).toBe(409);

        // High-value mismatch: needs_review with a pending draft claim.
        const hv = await orderWithEvidence({ scenario: "mismatch" });
        await Order.updateOne({ _id: hv._id }, { $set: { declaredValue: 5000 } });
        const b = await request(app).post(`/api/orders/${hv.orderId}/inspect`).set(auth(owner));
        const result = await poll(b.body.data.inspection._id);
        expect(result.status).toBe("needs_review");
        expect((await Claim.findById(result.claimId))?.status).toBe("pending_approval");
        const blocked = await request(app).post(`/api/inspections/${result._id}/retry`).set(auth(owner));
        expect(blocked.status).toBe(409);
        expect(blocked.body.message).toMatch(/Approve or reject/);
    });
});

describe("rate limiting", () => {
    it("limits expensive inspection requests per user", async () => {
        const limited = await createUser({ role: "owner", shopId: "shop-a" });
        overrideEnv({ RATE_LIMIT_INSPECTIONS_PER_15MIN: 2 });
        inspectionQueue.pause();
        const statuses: number[] = [];
        for (let i = 0; i < 3; i++) {
            const order = await createOrder({ orderId: `ORD-RL-${i}`, trackingCode: `TRK-RL-${i}` });
            statuses.push((await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(limited))).status);
        }
        expect(statuses).toEqual([202, 202, 429]);
    });
});

describe("restart recovery", () => {
    it("fails interrupted runs and re-queues pending ones", async () => {
        const order = await orderWithEvidence();
        const base = {
            orderId: order.orderId,
            orderRef: order._id,
            shopId: order.shopId,
            warehouseId: order.warehouseId,
            task: "Inspect",
            analysisMode: "demo" as const,
            planner: "deterministic" as const,
            requestedBy: owner.principal.userId,
        };
        const interrupted = await Inspection.create({ ...base, status: "processing" });
        const pending = await Inspection.create({ ...base, status: "pending" });

        const ran: string[] = [];
        const queue = new InspectionQueue(
            async (id) => void ran.push(id),
            () => 1,
        );
        const result = await recoverInterruptedInspections(queue);
        await queue.onIdle();

        expect(result).toEqual({ failed: 1, requeued: 1 });
        expect((await Inspection.findById(interrupted._id))?.status).toBe("failed");
        expect((await Inspection.findById(interrupted._id))?.error).toMatch(/server restart/);
        expect(ran).toEqual([pending.id]);
    });
});
