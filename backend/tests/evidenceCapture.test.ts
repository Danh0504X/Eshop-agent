import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { env, overrideEnv } from "../src/config/env";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { ScanSession } from "../src/models/ScanSession";
import { probeVideo } from "../src/services/ffmpegService";
import { extractFrames } from "../src/services/videoProcessingService";
import {
    connectTestDb,
    createOrder,
    createUser,
    disconnectTestDb,
    makeLiveWebm,
    makeVideo,
    type TestUser,
} from "./helpers";

let employee: TestUser;
let colleague: TestUser;
const defaults = { ALLOW_FILE_EVIDENCE: env.ALLOW_FILE_EVIDENCE };

beforeAll(async () => {
    await connectTestDb();
    employee = await createUser({ role: "employee", shopId: "shop-a", warehouseIds: ["wh-1"] });
    colleague = await createUser({ role: "employee", shopId: "shop-a", warehouseIds: ["wh-1"] });
});
afterAll(disconnectTestDb);
afterEach(() => overrideEnv(defaults));

const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

let seq = 0;
const newOrder = () => {
    seq++;
    return createOrder({ orderId: `ORD-CAP-${seq}`, trackingCode: `GHN-CAP-${seq}`, warehouseId: "wh-1" });
};

const scanFor = async (code: string, purpose: "packing" | "return", method = "camera") =>
    (await request(app).post("/api/scans").set(auth(employee)).send({ code, purpose, method })).body.data.scan
        .id as string;

interface UploadOptions {
    file?: string;
    filename?: string;
    contentType?: string;
    user?: TestUser;
}
const upload = async (orderId: string, fields: Record<string, string>, options: UploadOptions = {}) => {
    let req = request(app)
        .post(`/api/orders/${orderId}/media`)
        .set(auth(options.user ?? employee));
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    return req.attach("file", options.file ?? (await makeVideo("normal")), {
        filename: options.filename ?? "video.mp4",
        contentType: options.contentType ?? "video/mp4",
    });
};

/** Pretend the label was scanned `seconds` ago (Mongoose keeps createdAt immutable, so use the driver). */
const backdate = (scanId: string, seconds: number) =>
    ScanSession.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(scanId) },
        { $set: { createdAt: new Date(Date.now() - seconds * 1000) } },
    );

describe("evidence uploads are bound to a label scan", () => {
    it("records the scan and how the video was captured", async () => {
        const order = await newOrder();
        const scanId = await scanFor(order.trackingCode, "packing");
        const res = await upload(order.orderId, { type: "outbound", scanId, captureMethod: "file" });
        expect(res.status).toBe(201);
        expect(res.body.data.media.capture).toMatchObject({
            scanId,
            scanMethod: "camera",
            manualEntry: false,
            captureMethod: "file",
        });
        const scan = await ScanSession.findById(scanId);
        expect(String(scan?.mediaRef)).toBe(res.body.data.media._id);
        expect(scan?.mediaLinkedAt).toBeInstanceOf(Date);
    });

    it("requires a scan and a capture method", async () => {
        const order = await newOrder();
        expect((await upload(order.orderId, { type: "outbound" })).status).toBe(400);
        const scanId = await scanFor(order.trackingCode, "packing");
        expect((await upload(order.orderId, { type: "outbound", scanId })).status).toBe(400);
        expect((await upload(order.orderId, { type: "outbound", scanId, captureMethod: "uploaded" })).status).toBe(400);
    });

    it("accepts only an unused scan of this order's label, made by the uploader for that video type", async () => {
        const order = await newOrder();
        const other = await newOrder();

        const returnScan = await scanFor(order.trackingCode, "return");
        const wrongType = await upload(order.orderId, { type: "outbound", scanId: returnScan, captureMethod: "file" });
        expect(wrongType.status).toBe(409);
        expect(wrongType.body.message).toMatch(/made for return/);

        const otherLabel = await scanFor(other.trackingCode, "packing");
        const mismatch = await upload(order.orderId, { type: "outbound", scanId: otherLabel, captureMethod: "file" });
        expect(mismatch.status).toBe(400);
        expect(mismatch.body.message).toMatch(/not the tracking code/);

        const scanId = await scanFor(order.trackingCode, "packing");
        const notMine = await upload(
            order.orderId,
            { type: "outbound", scanId, captureMethod: "file" },
            { user: colleague },
        );
        expect(notMine.status).toBe(403);

        expect((await upload(order.orderId, { type: "outbound", scanId, captureMethod: "file" })).status).toBe(201);
        const reused = await upload(order.orderId, {
            type: "outbound",
            scanId,
            captureMethod: "file",
            replaceExisting: "true",
            replacementReason: "Trying to reuse a scan",
        });
        expect(reused.status).toBe(409);
        expect(reused.body.message).toMatch(/already used for a video/);
    });

    it("marks videos whose tracking code was typed by hand", async () => {
        const order = await newOrder();
        const scanId = await scanFor(order.trackingCode, "return", "manual");
        const res = await upload(order.orderId, { type: "return", scanId, captureMethod: "file" });
        expect(res.status).toBe(201);
        expect(res.body.data.media.capture).toMatchObject({ scanMethod: "manual", manualEntry: true });
    });

    it("refuses attached files when ALLOW_FILE_EVIDENCE is off, without using up the scan", async () => {
        overrideEnv({ ALLOW_FILE_EVIDENCE: false });
        const order = await newOrder();
        const scanId = await scanFor(order.trackingCode, "packing");
        const file = await upload(order.orderId, { type: "outbound", scanId, captureMethod: "file" });
        expect(file.status).toBe(403);
        expect(file.body.message).toMatch(/record the video in the app/);

        await backdate(scanId, 30);
        const recorded = await upload(order.orderId, { type: "outbound", scanId, captureMethod: "recorded" });
        expect(recorded.status).toBe(201);
        expect(recorded.body.data.media.capture.captureMethod).toBe("recorded");
    });

    // The recording-time check in mediaService.uploadEvidence is temporarily disabled. When it is re-enabled,
    // un-skip this test and delete the "while the recording-time check is disabled" test below.
    it.skip("refuses a recorded video longer than the time since its scan, and accepts it once that is plausible", async () => {
        const order = await newOrder();
        const scanId = await scanFor(order.trackingCode, "return");
        const long = await makeVideo("long"); // 12 s
        const tooLong = await upload(
            order.orderId,
            { type: "return", scanId, captureMethod: "recorded" },
            { file: long },
        );
        expect(tooLong.status).toBe(400);
        expect(tooLong.body.message).toMatch(/record the video after scanning/);

        await backdate(scanId, 20);
        const ok = await upload(
            order.orderId,
            {
                type: "return",
                scanId,
                captureMethod: "recorded",
                recordingStartedAt: new Date(Date.now() - 15_000).toISOString(),
                recordingEndedAt: new Date(Date.now() - 2_000).toISOString(),
            },
            { file: long },
        );
        expect(ok.status).toBe(201);
        expect(ok.body.data.media.capture.recordingStartedAt).toBeTypeOf("string");
    });

    it("accepts a recorded video longer than the time since its scan while the recording-time check is disabled", async () => {
        const order = await newOrder();
        const scanId = await scanFor(order.trackingCode, "return");
        const res = await upload(
            order.orderId,
            { type: "return", scanId, captureMethod: "recorded" },
            { file: await makeVideo("long") }, // 12 s, uploaded right after the scan
        );
        expect(res.status).toBe(201);
        expect(res.body.data.media.capture.captureMethod).toBe("recorded");
    });
});

describe("browser recordings without a duration header", () => {
    it("measures the duration from packet timestamps, so upload checks and frame extraction work", async () => {
        const live = await makeLiveWebm(); // 4 s, written like a MediaRecorder file
        expect((await probeVideo(live)).durationSec).toBeCloseTo(4, 0);

        const order = await newOrder();
        const scanId = await scanFor(order.trackingCode, "return");
        await backdate(scanId, 10);
        const res = await upload(
            order.orderId,
            { type: "return", scanId, captureMethod: "recorded" },
            { file: live, filename: "recording.webm", contentType: "video/webm" },
        );
        expect(res.status).toBe(201);

        const extracted = await extractFrames(res.body.data.media._id);
        expect(extracted.frames).toHaveLength(env.FRAMES_PER_VIDEO);
        expect((await MediaEvidence.findById(res.body.data.media._id))?.metadata?.durationSec).toBeCloseTo(4, 0);
    });
});
