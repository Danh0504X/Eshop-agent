import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { env, overrideEnv } from "../src/config/env";
import { Inspection } from "../src/models/Inspection";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { setVisionProvider } from "../src/services/vision";
import { DemoVisionProvider } from "../src/services/vision/demoVisionProvider";
import { storage } from "../src/services/storageService";
import { extractFrames, extractSegmentFrames } from "../src/services/videoProcessingService";
import { analyzeEvidence } from "../src/services/visionService";
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
const defaults = { MAX_SEGMENT_SECONDS: env.MAX_SEGMENT_SECONDS, MAX_FRAMES_PER_SEGMENT: env.MAX_FRAMES_PER_SEGMENT };

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
});
afterAll(disconnectTestDb);
afterEach(() => {
    overrideEnv(defaults);
    setVisionProvider(undefined);
});

/** A processed return video (4 s synthetic clip, 8 baseline frames). */
const processedReturn = async () => {
    const order = await createOrder();
    const media = await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
    await extractFrames(media.id);
    return { order, media: (await MediaEvidence.findById(media.id))! };
};

const snapshotBaseline = (media: InstanceType<typeof MediaEvidence>) =>
    media.frames
        .filter((f) => f.origin !== "segment")
        .map((f) => ({ frameId: f.frameId, key: f.storageKey, t: f.timestampSec }));

describe("extractSegmentFrames", () => {
    it("adds uniquely named frames inside the requested range and leaves baseline frames untouched", async () => {
        const { media } = await processedReturn();
        const before = snapshotBaseline(media);

        const result = await extractSegmentFrames(media.id, {
            startSec: 1,
            endSec: 3,
            count: 4,
            inspectionId: "insp-1",
            question: "Is there a scratch on the casing?",
        });

        expect(result).toMatchObject({ segmentId: "S1", startSec: 1, endSec: 3, cached: false });
        expect(result.frames.map((f) => f.frameId)).toEqual(["RET-S1-01", "RET-S1-02", "RET-S1-03", "RET-S1-04"]);
        expect(result.frames.map((f) => f.timestampSec)).toEqual([1.25, 1.75, 2.25, 2.75]);

        const saved = (await MediaEvidence.findById(media.id))!;
        expect(snapshotBaseline(saved)).toEqual(before);
        for (const f of saved.frames) expect(await storage().exists(f.storageKey)).toBe(true);
        expect(saved.frames.filter((f) => f.origin === "segment")).toHaveLength(4);
        expect(saved.segments[0]).toMatchObject({
            segmentId: "S1",
            startSec: 1,
            endSec: 3,
            frameIds: ["RET-S1-01", "RET-S1-02", "RET-S1-03", "RET-S1-04"],
            inspectionId: "insp-1",
            question: "Is there a scratch on the casing?",
        });
        expect(new Set(saved.frames.map((f) => f.frameId)).size).toBe(saved.frames.length);
    });

    it("returns the existing frames for an identical request and numbers a new segment S2", async () => {
        const { media } = await processedReturn();
        await extractSegmentFrames(media.id, { startSec: 0.5, endSec: 1.5, count: 2 });
        const again = await extractSegmentFrames(media.id, { startSec: 0.5, endSec: 1.5, count: 2 });
        expect(again).toMatchObject({ segmentId: "S1", cached: true });

        const second = await extractSegmentFrames(media.id, { startSec: 2, endSec: 3.5, count: 2 });
        expect(second.segmentId).toBe("S2");
        expect(second.frames.map((f) => f.frameId)).toEqual(["RET-S2-01", "RET-S2-02"]);
        const saved = (await MediaEvidence.findById(media.id))!;
        expect(saved.segments).toHaveLength(2);
        expect(saved.frames).toHaveLength(8 + 2 + 2);
    });

    it("rejects invalid or oversized ranges without changing the evidence", async () => {
        overrideEnv({ MAX_SEGMENT_SECONDS: 2, MAX_FRAMES_PER_SEGMENT: 3 });
        const { media } = await processedReturn();
        const cases: Array<[{ startSec: number; endSec: number; count?: number }, RegExp]> = [
            [{ startSec: -1, endSec: 1 }, /0 or more/],
            [{ startSec: 2, endSec: 2 }, /greater than startSeconds/],
            [{ startSec: 3, endSec: 9 }, /outside it/],
            [{ startSec: 0.5, endSec: 3.5 }, /at most 2 s/],
            [{ startSec: 1, endSec: 2, count: 4 }, /from 1 to 3/],
            [{ startSec: 1, endSec: 2, count: 1.5 }, /from 1 to 3/],
        ];
        for (const [req, message] of cases) {
            await expect(extractSegmentFrames(media.id, req)).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringMatching(message),
                errors: [{ retryable: false }],
            });
        }
        const saved = (await MediaEvidence.findById(media.id))!;
        expect(saved.status).toBe("processed");
        expect(saved.segments).toHaveLength(0);
        expect(saved.frames).toHaveLength(8);
    });

    it("requires the baseline extraction first", async () => {
        const order = await createOrder();
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
        await expect(extractSegmentFrames(media.id, { startSec: 0, endSec: 1 })).rejects.toMatchObject({
            code: "INVALID_STATE",
        });
    });
});

describe("baseline frames stay valid", () => {
    it("re-extracting baseline frames keeps segment frames", async () => {
        const { media } = await processedReturn();
        await extractSegmentFrames(media.id, { startSec: 1, endSec: 2, count: 2 });
        await extractFrames(media.id, { force: true });
        const saved = (await MediaEvidence.findById(media.id))!;
        expect(saved.frames.filter((f) => f.origin !== "segment")).toHaveLength(8);
        expect(saved.frames.filter((f) => f.segmentId === "S1")).toHaveLength(2);
        for (const f of saved.frames) expect(await storage().exists(f.storageKey)).toBe(true);
    });

    it("refuses to re-extract baseline frames once an inspection cites them", async () => {
        const { order, media } = await processedReturn();
        await Inspection.create({
            orderId: order.orderId,
            orderRef: order._id,
            shopId: order.shopId,
            warehouseId: order.warehouseId,
            task: "Inspect",
            analysisMode: "demo",
            planner: "deterministic",
            returnAnalysis: { mediaId: media.id },
        });
        const before = snapshotBaseline(media);
        await expect(extractFrames(media.id, { force: true })).rejects.toMatchObject({
            code: "INVALID_STATE",
            message: expect.stringMatching(/already cited as evidence/),
        });
        expect(snapshotBaseline((await MediaEvidence.findById(media.id))!)).toEqual(before);
    });

    it("initial analysis uses baseline frames only", async () => {
        const { order, media } = await processedReturn();
        await extractSegmentFrames(media.id, { startSec: 1, endSec: 2, count: 3 });
        setVisionProvider(new DemoVisionProvider());
        const record = await analyzeEvidence((await MediaEvidence.findById(media.id))!, order);
        expect(record.framesAnalyzed.map((f) => f.frameId)).toEqual([
            "RET-01",
            "RET-02",
            "RET-03",
            "RET-04",
            "RET-05",
            "RET-06",
            "RET-07",
            "RET-08",
        ]);
    });

    it("serves segment frame images through the existing frame endpoint", async () => {
        const order = await createOrder({ shopId: "shop-a" });
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
        await extractFrames(media.id);
        await extractSegmentFrames(media.id, { startSec: 1, endSec: 2, count: 1 });
        const res = await request(app)
            .get(`/api/media/${media.id}/frames/RET-S1-01`)
            .set("Authorization", `Bearer ${owner.token}`);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("image/jpeg");
        const other = await createUser({ role: "owner", shopId: "shop-other" });
        const denied = await request(app)
            .get(`/api/media/${media.id}/frames/RET-S1-01`)
            .set("Authorization", `Bearer ${other.token}`);
        expect(denied.status).toBe(404);
    });
});

