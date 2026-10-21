/**
 * OPT-IN integration test against the real Gemini API. Skipped unless both are set:
 *
 *   PowerShell:  $env:GEMINI_INTEGRATION="1"; $env:GEMINI_API_KEY="..."; npm run test:gemini
 *
 * Optional: GEMINI_TEST_VIDEO=<path to a real .mp4> (defaults to a synthetic FFmpeg test pattern).
 * This only proves the request/response contract works (schema accepted, output valid). It says nothing
 * about real-world visual accuracy.
 */
import fs from "node:fs";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { overrideEnv } from "../../src/config/env";
import { MediaEvidence } from "../../src/models/MediaEvidence";
import { setVisionProvider } from "../../src/services/vision";
import { GeminiVisionProvider } from "../../src/services/vision/geminiVisionProvider";
import { extractFrames } from "../../src/services/videoProcessingService";
import { analyzeEvidence } from "../../src/services/visionService";
import { connectTestDb, createMediaFromFile, createOrder, disconnectTestDb, makeVideo } from "../helpers";

const enabled = process.env.GEMINI_INTEGRATION === "1" && Boolean(process.env.GEMINI_API_KEY);

describe.skipIf(!enabled)("Gemini vision (real API)", () => {
    beforeAll(async () => {
        await connectTestDb();
        overrideEnv({
            GEMINI_API_KEY: process.env.GEMINI_API_KEY,
            ...(process.env.GEMINI_VISION_MODEL ? { GEMINI_VISION_MODEL: process.env.GEMINI_VISION_MODEL } : {}),
            AI_TIMEOUT_MS: 120_000,
        });
        setVisionProvider(new GeminiVisionProvider());
    });
    afterAll(async () => {
        setVisionProvider(undefined);
        await disconnectTestDb();
    });

    it("returns schema-valid analysis that cites only frames that were sent", async () => {
        const video =
            process.env.GEMINI_TEST_VIDEO && fs.existsSync(process.env.GEMINI_TEST_VIDEO)
                ? process.env.GEMINI_TEST_VIDEO
                : await makeVideo("normal");
        const order = await createOrder({ product: { name: "Wireless Headphones", color: "black" } });
        const media = await createMediaFromFile(order, "return", video, new mongoose.Types.ObjectId().toString());
        await extractFrames(media.id);

        const record = await analyzeEvidence((await MediaEvidence.findById(media.id))!, order);
        const sent = new Set(record.framesAnalyzed.map((f) => f.frameId));
        const cited = record.result.items.flatMap((i) => [...i.productType.frameIds, ...i.quantity.frameIds]);

        expect(record.source).toBe("ai");
        expect(record.result.overallConfidence).toBeGreaterThanOrEqual(0);
        expect(cited.every((id) => sent.has(id))).toBe(true);
        console.info("Gemini model:", record.model, "usage:", record.usage, "contents:", record.result.packageContents);
    }, 180_000);
});
