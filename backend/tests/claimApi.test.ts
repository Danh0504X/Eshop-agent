import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { AuditLog } from "../src/models/AuditLog";
import { Inspection } from "../src/models/Inspection";
import { Order } from "../src/models/Order";
import { inspectionQueue } from "../src/services/inspectionQueue";
import { setVisionProvider } from "../src/services/vision";
import {
    connectTestDb,
    createMediaFromFile,
    createOrder,
    createUser,
    disconnectTestDb,
    makeVideo,
    type TestUser,
    useAdvisoryDemoProvider,
} from "./helpers";

let owner: TestUser;
let employee: TestUser;
let otherShop: TestUser;

beforeAll(async () => {
    await connectTestDb();
    setVisionProvider(undefined);
    owner = await createUser({ role: "owner", shopId: "shop-a" });
    employee = await createUser({ role: "employee", shopId: "shop-a", warehouseIds: ["wh-1"] });
    otherShop = await createUser({ role: "owner", shopId: "shop-b" });
});
afterAll(async () => {
    await inspectionQueue.onIdle();
    await disconnectTestDb();
});

const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

let seq = 0;
/** Run a real (demo-mode) inspection through the API and return the resulting claim id. */
const draftClaim = async () => {
    seq++;
    const order = await createOrder({
        orderId: `ORD-CL-${seq}`,
        trackingCode: `TRK-CL-${seq}`,
        demoScenario: "mismatch",
    });
    await createMediaFromFile(order, "outbound", await makeVideo("normal"), owner.principal.userId);
    await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
    const res = await request(app).post(`/api/orders/${order.orderId}/inspect`).set(auth(owner));
    await inspectionQueue.onIdle();
    const inspection = await Inspection.findById(res.body.data.inspection._id);
    expect(inspection?.claimId).toBeDefined();
    return { claimId: inspection!.claimId!.toString(), inspectionId: inspection!.id, order };
};

describe("claim review API", () => {
    it("lets employees view a claim and download its PDF report, and audits the export", async () => {
        const { claimId } = await draftClaim();
        const res = await request(app).get(`/api/claims/${claimId}`).set(auth(employee));
        expect(res.status).toBe(200);
        expect(res.body.data.claim).toMatchObject({
            status: "pending_approval",
            aiGenerated: true,
            analysisMode: "demo",
            reportUrl: `/api/claims/${claimId}/report`,
            externalSubmission: "not_supported",
        });
        expect(res.body.data.claim.reportStorageKey).toBeUndefined();

        const pdf = await request(app)
            .get(`/api/claims/${claimId}/report`)
            .set(auth(employee))
            .buffer(true)
            .parse((r, cb) => {
                const chunks: Buffer[] = [];
                r.on("data", (c: Buffer) => chunks.push(c));
                r.on("end", () => cb(null, Buffer.concat(chunks)));
            });
        expect(pdf.status).toBe(200);
        expect(pdf.headers["content-type"]).toBe("application/pdf");
        expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
        expect(await AuditLog.countDocuments({ action: "claim.report_download", claimId })).toBe(1);

        const listed = await request(app).get(`/api/claims?status=pending_approval`).set(auth(employee));
        expect(listed.body.data.claims.map((c: { _id: string }) => c._id)).toContain(claimId);
    });

    it("requires an owner and a recorded reason to approve", async () => {
        const { claimId } = await draftClaim();
        const asEmployee = await request(app)
            .post(`/api/claims/${claimId}/approve`)
            .set(auth(employee))
            .send({ reason: "Looks right to me" });
        expect(asEmployee.status).toBe(403);

        const noReason = await request(app).post(`/api/claims/${claimId}/approve`).set(auth(owner)).send({});
        expect(noReason.status).toBe(400);

        const ok = await request(app)
            .post(`/api/claims/${claimId}/approve`)
            .set(auth(owner))
            .send({
                reason: "Reviewed frames OUT-05 and RET-05; model differs",
                finalDetermination: "discrepancy_confirmed_by_reviewer",
            });
        expect(ok.status).toBe(200);
        expect(ok.body.data.claim.status).toBe("approved");
        expect(ok.body.data.claim.approval).toMatchObject({
            decision: "approved",
            decidedBy: owner.principal.userId,
            finalDetermination: "discrepancy_confirmed_by_reviewer",
        });
        expect(ok.body.data.claim.history.at(-1)).toMatchObject({ from: "pending_approval", to: "approved" });
        expect(await AuditLog.countDocuments({ action: "claim.approve", claimId })).toBe(1);

        const again = await request(app)
            .post(`/api/claims/${claimId}/approve`)
            .set(auth(owner))
            .send({ reason: "Approve twice" });
        expect(again.status).toBe(409);
    });

    it("records a manual submission only after approval, then resolves", async () => {
        const { claimId } = await draftClaim();
        const early = await request(app).post(`/api/claims/${claimId}/mark-submitted`).set(auth(owner)).send({});
        expect(early.status).toBe(409);

        await request(app)
            .post(`/api/claims/${claimId}/approve`)
            .set(auth(owner))
            .send({ reason: "Evidence reviewed" });
        const submitted = await request(app)
            .post(`/api/claims/${claimId}/mark-submitted`)
            .set(auth(owner))
            .send({ externalReference: "MKT-12345" });
        expect(submitted.status).toBe(200);
        expect(submitted.body.message).toMatch(/did not submit anything externally/);
        expect(submitted.body.data.claim.history.at(-1).reason).toMatch(/Submitted manually.*MKT-12345/);

        const resolved = await request(app)
            .post(`/api/claims/${claimId}/resolve`)
            .set(auth(owner))
            .send({ reason: "Marketplace refunded" });
        expect(resolved.body.data.claim.status).toBe("resolved");
    });

    it("rejects with a reason and blocks later transitions", async () => {
        const { claimId } = await draftClaim();
        const rejected = await request(app)
            .post(`/api/claims/${claimId}/reject`)
            .set(auth(owner))
            .send({ reason: "Colour difference is due to lighting" });
        expect(rejected.body.data.claim).toMatchObject({ status: "rejected", approval: { decision: "rejected" } });
        const approveAfter = await request(app)
            .post(`/api/claims/${claimId}/approve`)
            .set(auth(owner))
            .send({ reason: "Changed my mind" });
        expect(approveAfter.status).toBe(409);
    });

    it("closes the advisory review task when the owner decides the claim", async () => {
        useAdvisoryDemoProvider();
        const { claimId, inspectionId, order } = await draftClaim().finally(() => setVisionProvider(undefined));
        expect((await Inspection.findById(inspectionId))?.status).toBe("needs_review");

        await request(app)
            .post(`/api/claims/${claimId}/approve`)
            .set(auth(owner))
            .send({ reason: "Claim and flagged footage reviewed" });
        const inspection = await Inspection.findById(inspectionId);
        expect(inspection?.status).toBe("completed");
        expect(inspection?.reviewTask).toMatchObject({
            status: "resolved",
            resolutionNote: expect.stringMatching(/approved/),
        });
        expect((await Order.findById(order._id))?.inspectionStatus).toBe("completed");
    });

    it("hides other shops' claims", async () => {
        const { claimId } = await draftClaim();
        expect((await request(app).get(`/api/claims/${claimId}`).set(auth(otherShop))).status).toBe(404);
        expect((await request(app).get(`/api/claims/${claimId}/report`).set(auth(otherShop))).status).toBe(404);
        expect(
            (
                await request(app)
                    .post(`/api/claims/${claimId}/approve`)
                    .set(auth(otherShop))
                    .send({ reason: "Not my shop" })
            ).status,
        ).toBe(404);
        const list = await request(app).get(`/api/claims`).set(auth(otherShop));
        expect(list.body.data.claims).toHaveLength(0);
    });
});
