import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { computeMetrics } from "../src/services/ffmpegService";
import { storage } from "../src/services/storageService";
import { extractFrames, sampleTimestamps } from "../src/services/videoProcessingService";
import { connectTestDb, createMediaFromFile, createOrder, disconnectTestDb, makeVideo } from "./helpers";

const uploader = new mongoose.Types.ObjectId().toString();

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

describe("frame metrics", () => {
    it("separates flat, dark images from detailed ones", () => {
        const w = 20;
        const h = 20;
        const flatDark = Buffer.alloc(w * h, 10);
        const checker = Buffer.from(
            Array.from({ length: w * h }, (_, i) => (((i % w) + Math.floor(i / w)) % 2 ? 255 : 0)),
        );
        expect(computeMetrics(flatDark, w, h)).toEqual({ brightness: 10, sharpness: 0 });
        const detailed = computeMetrics(checker, w, h);
        expect(detailed.sharpness).toBeGreaterThan(1000);
        expect(detailed.brightness).toBeCloseTo(127.5, 0);
    });

    it("spreads sample timestamps across the video", () => {
        expect(sampleTimestamps(8, 4)).toEqual([1, 3, 5, 7]);
    });
});

describe("extractFrames", () => {
    it("extracts, scores and persists frames for a clear video", async () => {
        const order = await createOrder();
        const media = await createMediaFromFile(order, "outbound", await makeVideo("normal"), uploader);

        const result = await extractFrames(media.id);
        expect(result.cached).toBe(false);
        expect(result.frames).toHaveLength(8);
        expect(result.frames[0].frameId).toBe("OUT-01");
        expect(result.frames.every((f) => f.quality === "ok")).toBe(true);
        expect(result.quality.continuous).toBe(true);
        expect(result.durationSec).toBeCloseTo(4, 0);

        const saved = await MediaEvidence.findById(media.id);
        expect(saved?.status).toBe("processed");
        expect(saved?.frames).toHaveLength(8);
        for (const frame of saved!.frames) expect(await storage().exists(frame.storageKey)).toBe(true);

        const again = await extractFrames(media.id);
        expect(again.cached).toBe(true);
        expect(saved?.extractionAttempts).toBe(1);
    });

    it("flags dark and blurry footage", async () => {
        const order = await createOrder();
        const dark = await createMediaFromFile(order, "return", await makeVideo("dark"), uploader);
        const darkResult = await extractFrames(dark.id);
        expect(darkResult.quality.darkFrameRatio).toBe(1);

        const order2 = await createOrder();
        const blurry = await createMediaFromFile(order2, "return", await makeVideo("blurry"), uploader);
        const blurryResult = await extractFrames(blurry.id);
        expect(blurryResult.quality.blurryFrameRatio).toBe(1);
        expect(blurryResult.frames[0].frameId).toBe("RET-01");
    });

    it("rejects videos shorter than the minimum duration and records the failure", async () => {
        const order = await createOrder();
        const media = await createMediaFromFile(order, "return", await makeVideo("short"), uploader);
        await expect(extractFrames(media.id)).rejects.toMatchObject({ code: "PROCESSING_ERROR" });
        const saved = await MediaEvidence.findById(media.id);
        expect(saved?.status).toBe("failed");
        expect(saved?.processingError).toMatch(/at least/);
    });

    it("fails explicitly when the stored file is missing", async () => {
        const order = await createOrder();
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), uploader);
        await storage().delete(media.storageKey);
        await expect(extractFrames(media.id)).rejects.toMatchObject({ code: "PROCESSING_ERROR" });
        expect((await MediaEvidence.findById(media.id))?.status).toBe("failed");
    });
});
