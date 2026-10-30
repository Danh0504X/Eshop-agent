import { ApiError as GenAiApiError, FinishReason } from "@google/genai";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VisionAnalysis } from "../src/agent/schemas";
import { env, overrideEnv } from "../src/config/env";
import { MediaEvidence } from "../src/models/MediaEvidence";
import type { GeminiModelsClient } from "../src/services/ai/gemini";
import { getVisionProvider, setVisionProvider } from "../src/services/vision";
import { GeminiVisionProvider } from "../src/services/vision/geminiVisionProvider";
import { extractFrames } from "../src/services/videoProcessingService";
import { analyzeEvidence } from "../src/services/visionService";
import { connectTestDb, createMediaFromFile, createOrder, disconnectTestDb, makeVideo } from "./helpers";
import { demoRecord } from "./fixtures";

const uploader = new mongoose.Types.ObjectId().toString();
const providerDefaults = {
    activeProvider: env.activeProvider,
    aiMode: env.aiMode,
    AI_RETRY_BASE_DELAY_MS: env.AI_RETRY_BASE_DELAY_MS,
    AI_RETRY_MAX_DELAY_MS: env.AI_RETRY_MAX_DELAY_MS,
    GEMINI_THINKING_LEVEL: env.GEMINI_THINKING_LEVEL,
};
// Keep real backoff waits out of unit tests.
const fastRetries = { AI_RETRY_BASE_DELAY_MS: 1, AI_RETRY_MAX_DELAY_MS: 5 };

let sample: VisionAnalysis;

beforeAll(async () => {
    await connectTestDb();
    sample = (await demoRecord("normal", "return")).result;
    overrideEnv(fastRetries);
});
afterAll(async () => {
    overrideEnv(providerDefaults);
    await disconnectTestDb();
});
afterEach(() => {
    setVisionProvider(undefined);
    overrideEnv({ ...providerDefaults, ...fastRetries });
});

const request = {
    evidenceType: "return" as const,
    frames: [
        { frameId: "RET-01", timestampSec: 0.5, jpeg: Buffer.from([0xff, 0xd8, 0xff]) },
        { frameId: "RET-02", timestampSec: 1.5, jpeg: Buffer.from([0xff, 0xd8, 0xfe]) },
    ],
    expected: { productName: "Headphones", expectedQuantity: 1, expectedAccessories: ["cable"] },
};

/** A GenerateContentResponse-like object; `text` mirrors the SDK getter. */
const geminiResponse = (text: string | undefined, finishReason: FinishReason = FinishReason.STOP, extra = {}) => ({
    candidates: [{ content: { role: "model", parts: text ? [{ text }] : [] }, finishReason }],
    text,
    modelVersion: "gemini-test-model",
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 150 },
    ...extra,
});

const fakeClient = (impl: () => unknown) => {
    const generateContent = vi.fn(async (..._args: unknown[]) => impl());
    return { client: { models: { generateContent } } as unknown as GeminiModelsClient, generateContent };
};

describe("GeminiVisionProvider (mocked client)", () => {
    it("sends labelled inline frames with the JSON schema and returns validated output with usage", async () => {
        const { client, generateContent } = fakeClient(() => geminiResponse(JSON.stringify(sample)));
        const result = await new GeminiVisionProvider(client).analyze(request);

        expect(result.analysis.packageContents).toBe("items_present");
        expect(result.model).toBe("gemini-test-model");
        expect(result.usage).toEqual({ promptTokens: 1200, outputTokens: 300, thoughtsTokens: 150, apiAttempts: 1 });

        const params = generateContent.mock.calls[0][0] as unknown as {
            model: string;
            contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string } }> }>;
            config: { responseMimeType: string; responseJsonSchema: { properties: object }; systemInstruction: string };
        };
        expect(params.model).toBe(env.GEMINI_VISION_MODEL);
        const parts = params.contents[0].parts;
        expect(parts.filter((p) => p.inlineData?.mimeType === "image/jpeg")).toHaveLength(2);
        expect(parts[0].text).toBe("Frame RET-01 at t=0.5s");
        expect(params.config.responseMimeType).toBe("application/json");
        const fields = Object.keys(params.config.responseJsonSchema.properties);
        expect(fields).toContain("packageContents");
        expect(fields).not.toContain("visibleIdentifiers"); // the tracking code is bound by scanning, not read by AI
        expect(params.config.systemInstruction).toMatch(/untrusted data/);
    });

    it("rejects malformed JSON and schema-invalid output as retryable errors", async () => {
        const notJson = fakeClient(() => geminiResponse("{not json"));
        await expect(new GeminiVisionProvider(notJson.client).analyze(request)).rejects.toMatchObject({
            code: "AI_ERROR",
            message: expect.stringMatching(/malformed JSON/),
            errors: [{ retryable: true }],
        });

        const wrongShape = fakeClient(() => geminiResponse(JSON.stringify({ ...sample, packageContents: "maybe" })));
        await expect(new GeminiVisionProvider(wrongShape.client).analyze(request)).rejects.toMatchObject({
            message: expect.stringMatching(/malformed output: packageContents/),
            errors: [{ retryable: true }],
        });

        const empty = fakeClient(() => geminiResponse(undefined));
        await expect(new GeminiVisionProvider(empty.client).analyze(request)).rejects.toMatchObject({
            errors: [{ retryable: true }],
        });
    });

    it("treats safety blocks as final and truncation as retryable", async () => {
        const blocked = fakeClient(() => geminiResponse(undefined, FinishReason.SAFETY));
        await expect(new GeminiVisionProvider(blocked.client).analyze(request)).rejects.toMatchObject({
            message: expect.stringMatching(/declined/),
            errors: [{ retryable: false }],
        });

        const promptBlocked = fakeClient(() =>
            geminiResponse(undefined, FinishReason.STOP, { promptFeedback: { blockReason: "OTHER" } }),
        );
        await expect(new GeminiVisionProvider(promptBlocked.client).analyze(request)).rejects.toMatchObject({
            errors: [{ retryable: false }],
        });

        const truncated = fakeClient(() => geminiResponse(undefined, FinishReason.MAX_TOKENS));
        await expect(new GeminiVisionProvider(truncated.client).analyze(request)).rejects.toMatchObject({
            message: expect.stringMatching(/truncated/),
            errors: [{ retryable: true }],
        });
    });

    it("classifies API errors: persistent 429/503 are final, timeouts and 500 retry, bad key and unknown model do not", async () => {
        const cases: Array<[unknown, RegExp, boolean]> = [
            // 429/503 are retried with backoff inside the provider; if they persist the error is final.
            [
                new GenAiApiError({ message: "quota", status: 429 }),
                /rate limit or quota \(429\) persisted after 3 attempt/,
                false,
            ],
            [
                new GenAiApiError({ message: "unavailable", status: 503 }),
                /service unavailable \(503\) persisted after 3/,
                false,
            ],
            [new GenAiApiError({ message: "internal", status: 500 }), /service error/, true],
            [new GenAiApiError({ message: "bad key", status: 403 }), /API key/, false],
            [new GenAiApiError({ message: "no model", status: 404 }), /gemini:models/, false],
            [
                Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
                /timed out/,
                true,
            ],
            [new TypeError("fetch failed"), /could not reach/, true],
        ];
        for (const [error, message, retryable] of cases) {
            const { client } = fakeClient(() => {
                throw error;
            });
            await expect(new GeminiVisionProvider(client).analyze(request)).rejects.toMatchObject({
                code: "AI_ERROR",
                message: expect.stringMatching(message),
                errors: [{ retryable }],
            });
        }
    });
});

describe("Gemini transport retries and time budget", () => {
    it("backs off on 503 and succeeds on a later attempt, recording the attempts", async () => {
        let calls = 0;
        const { client, generateContent } = fakeClient(() => {
            if (++calls === 1) throw new GenAiApiError({ message: "high demand", status: 503 });
            return geminiResponse(JSON.stringify(sample));
        });
        const result = await new GeminiVisionProvider(client).analyze(request);
        expect(generateContent).toHaveBeenCalledTimes(2);
        expect(result.usage?.apiAttempts).toBe(2);
    });

    it("does not retry non-transient errors", async () => {
        const { client, generateContent } = fakeClient(() => {
            throw new GenAiApiError({ message: "bad", status: 400 });
        });
        await expect(new GeminiVisionProvider(client).analyze(request)).rejects.toMatchObject({
            errors: [{ retryable: false }],
        });
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it("shortens the per-request timeout to fit the remaining budget", async () => {
        const { client, generateContent } = fakeClient(() => geminiResponse(JSON.stringify(sample)));
        await new GeminiVisionProvider(client).analyze({ ...request, deadlineMs: Date.now() + 30_000 });
        const timeout = (generateContent.mock.calls[0][0] as { config: { httpOptions: { timeout: number } } }).config
            .httpOptions.timeout;
        expect(timeout).toBeLessThanOrEqual(28_000);
        expect(timeout).toBeGreaterThan(20_000);

        await new GeminiVisionProvider(client).analyze(request);
        const unbounded = (generateContent.mock.calls[1][0] as { config: { httpOptions: { timeout: number } } }).config
            .httpOptions.timeout;
        expect(unbounded).toBe(env.AI_TIMEOUT_MS);
    });

    it("fails fast without calling Gemini when the budget is already used up", async () => {
        const { client, generateContent } = fakeClient(() => geminiResponse(JSON.stringify(sample)));
        await expect(
            new GeminiVisionProvider(client).analyze({ ...request, deadlineMs: Date.now() + 3_000 }),
        ).rejects.toMatchObject({
            message: expect.stringMatching(/time budget exhausted/),
            errors: [{ retryable: false }],
        });
        expect(generateContent).not.toHaveBeenCalled();
    });

    it("sends the configured thinking level and omits it when unset", async () => {
        const { client, generateContent } = fakeClient(() => geminiResponse(JSON.stringify(sample)));
        overrideEnv({ GEMINI_THINKING_LEVEL: undefined });
        await new GeminiVisionProvider(client).analyze(request);
        overrideEnv({ GEMINI_THINKING_LEVEL: "LOW" });
        await new GeminiVisionProvider(client).analyze(request);
        const configs = generateContent.mock.calls.map((c) => (c[0] as { config: Record<string, unknown> }).config);
        expect(configs[0].thinkingConfig).toBeUndefined();
        expect(configs[1].thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    });
});

describe("Gemini provider selection and pipeline", () => {
    it("is the provider used in real mode when AI_PROVIDER=gemini", () => {
        overrideEnv({ activeProvider: "gemini", aiMode: "real" });
        setVisionProvider(undefined);
        expect(getVisionProvider()).toBeInstanceOf(GeminiVisionProvider);
    });

    it("analyses real extracted frames end to end and records usage without customer data", async () => {
        const order = await createOrder({
            customer: { name: "Hoang Van E", phone: "0901 999 888", address: "3 Hai Ba Trung Street" },
        });
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), uploader);
        await extractFrames(media.id);
        const { client, generateContent } = fakeClient(() => geminiResponse(JSON.stringify(sample)));
        setVisionProvider(new GeminiVisionProvider(client));

        const record = await analyzeEvidence((await MediaEvidence.findById(media.id))!, order);
        expect(record.source).toBe("ai");
        expect(record.model).toBe("gemini-test-model");
        expect(record.usage).toMatchObject({ promptTokens: 1200, apiAttempts: 1 });
        expect(record.framesAnalyzed).toHaveLength(8);

        const sent = JSON.stringify(generateContent.mock.calls[0][0]);
        expect(sent).not.toMatch(/Hoang Van E|0901 999 888|Hai Ba Trung/);
        expect(sent).not.toContain(order.orderId);
    });
});
