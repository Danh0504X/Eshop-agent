import { FinishReason } from "@google/genai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeSegmentObservation, type SegmentObservation } from "../src/agent/schemas";
import { MediaEvidence } from "../src/models/MediaEvidence";
import type { GeminiModelsClient } from "../src/services/ai/gemini";
import { setVisionProvider } from "../src/services/vision";
import { DemoVisionProvider } from "../src/services/vision/demoVisionProvider";
import { GeminiVisionProvider } from "../src/services/vision/geminiVisionProvider";
import { extractFrames, extractSegmentFrames } from "../src/services/videoProcessingService";
import { analyzeEvidence, inspectSegmentFrames } from "../src/services/visionService";
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

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
});
afterAll(disconnectTestDb);
afterEach(() => setVisionProvider(undefined));

const observation = (overrides: Partial<SegmentObservation> = {}): SegmentObservation => ({
    answer: "A crack is visible on the casing.",
    verdict: "confirmed",
    observations: [{ description: "Crack on casing", certainty: "observed", frameIds: ["RET-S1-02"] }],
    imageConditions: { lighting: "good", focus: "sharp", notes: "" },
    suspectedInstructionText: [],
    uncertaintyNotes: [],
    overallConfidence: 0.8,
    ...overrides,
});

/** A processed return video with one 1-3 s segment of 4 frames. */
const segmentReady = async (scenario = "needs_closer_look") => {
    const order = await createOrder({ demoScenario: scenario });
    const media = await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
    await extractFrames(media.id);
    const segment = await extractSegmentFrames(media.id, { startSec: 1, endSec: 3, count: 4 });
    return { order, media: (await MediaEvidence.findById(media.id))!, segment };
};

describe("normalizeSegmentObservation", () => {
    it("keeps only frames that were sent and requires a grounded observation for a confirmed verdict", () => {
        const ungrounded = normalizeSegmentObservation(
            observation({ observations: [{ description: "Crack", certainty: "observed", frameIds: ["RET-99"] }] }),
            ["RET-S1-01", "RET-S1-02"],
        );
        expect(ungrounded.result.observations[0]).toMatchObject({ certainty: "uncertain", frameIds: [] });
        expect(ungrounded.result.verdict).toBe("inconclusive");
        expect(ungrounded.notes.join(" ")).toMatch(/downgraded to inconclusive/);

        const grounded = normalizeSegmentObservation(observation({ overallConfidence: 3 }), ["RET-S1-02"]);
        expect(grounded.result.verdict).toBe("confirmed");
        expect(grounded.result.overallConfidence).toBe(1);
    });
});

describe("Gemini segment inspection (mocked client)", () => {
    it("sends the segment frames, range and question with the segment schema and validates the answer", async () => {
        const generateContent = vi.fn(async (..._args: unknown[]) => ({
            candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: FinishReason.STOP }],
            text: JSON.stringify(observation()),
            modelVersion: "gemini-test",
            usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 90, thoughtsTokenCount: 40 },
        }));
        const provider = new GeminiVisionProvider({ models: { generateContent } } as unknown as GeminiModelsClient);
        const result = await provider.inspectSegment({
            evidenceType: "return",
            frames: [{ frameId: "RET-S1-02", timestampSec: 1.75, jpeg: Buffer.from([0xff, 0xd8]) }],
            startSec: 1,
            endSec: 3,
            question: "Is the casing cracked?",
            productName: "Smart Watch",
        });
        expect(result.observation.verdict).toBe("confirmed");
        expect(result.usage).toMatchObject({ promptTokens: 800, apiAttempts: 1 });

        const params = generateContent.mock.calls[0][0] as unknown as {
            contents: Array<{ parts: Array<{ text?: string }> }>;
            config: { systemInstruction: string; responseJsonSchema: { properties: object } };
        };
        expect(params.config.systemInstruction).toMatch(/closer look at a short segment/);
        expect(Object.keys(params.config.responseJsonSchema.properties)).toContain("verdict");
        expect(params.contents[0].parts.at(-1)?.text).toMatch(
            /Segment: 1\.0s to 3\.0s[\s\S]*Question: Is the casing cracked\?/,
        );
    });

    it("rejects malformed segment output as a retryable AI error", async () => {
        const generateContent = vi.fn(async () => ({
            candidates: [{ content: { role: "model", parts: [] }, finishReason: FinishReason.STOP }],
            text: JSON.stringify({ ...observation(), verdict: "probably" }),
        }));
        const provider = new GeminiVisionProvider({ models: { generateContent } } as unknown as GeminiModelsClient);
        await expect(
            provider.inspectSegment({
                evidenceType: "return",
                frames: [],
                startSec: 0,
                endSec: 1,
                question: "q",
                productName: "p",
            }),
        ).rejects.toMatchObject({ code: "AI_ERROR", errors: [{ retryable: true }] });
    });
});

describe("visionService with segment frames", () => {
    it("inspects real segment frames and records a grounded, demo-labelled answer", async () => {
        const { order, media } = await segmentReady();
        setVisionProvider(new DemoVisionProvider());
        const record = await inspectSegmentFrames(media, order, {
            segmentId: "S1",
            startSec: 1,
            endSec: 3,
            question: "Is there damage on the front casing?",
        });
        expect(record).toMatchObject({ segmentId: "S1", source: "demo", evidenceType: "return" });
        expect(record.framesAnalyzed.map((f) => f.frameId)).toEqual([
            "RET-S1-01",
            "RET-S1-02",
            "RET-S1-03",
            "RET-S1-04",
        ]);
        expect(record.result.verdict).toBe("confirmed");
        expect(record.result.observations[0].frameIds).toEqual(["RET-S1-02", "RET-S1-03"]);
    });

    it("re-analysis can include segment frames; the initial analysis does not", async () => {
        const { order, media, segment } = await segmentReady();
        setVisionProvider(new DemoVisionProvider());

        const initial = await analyzeEvidence(media, order);
        expect(initial.result.items[0].condition.status).toBe("uncertain");
        expect(initial.framesAnalyzed.every((f) => !f.frameId.includes("-S"))).toBe(true);

        const again = await analyzeEvidence(media, order, { extraFrameIds: segment.frames.map((f) => f.frameId) });
        expect(again.framesAnalyzed).toHaveLength(8 + 4);
        expect(again.result.items[0].condition).toMatchObject({
            status: "observed",
            damage: [{ kind: "crack", certainty: "observed", frameIds: ["RET-S1-02", "RET-S1-03"] }],
        });

        await expect(analyzeEvidence(media, order, { extraFrameIds: ["RET-S9-01"] })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
    });

    it("refuses segment inspection when the provider does not support it", async () => {
        const { order, media } = await segmentReady();
        setVisionProvider({ source: "ai", analyze: async () => ({ analysis: {} as never, model: null }) });
        await expect(
            inspectSegmentFrames(media, order, { segmentId: "S1", startSec: 1, endSec: 3, question: "q" }),
        ).rejects.toMatchObject({ code: "AI_ERROR", errors: [{ retryable: false }] });
    });
});
