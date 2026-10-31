import http from "node:http";
import type { AddressInfo } from "node:net";
import { FinishReason, GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, overrideEnv } from "../src/config/env";
import { callGemini, mergeChunks, type GeminiModelsClient } from "../src/services/ai/gemini";

/**
 * The real SDK against a local HTTP server, so aborts, streaming and error statuses go through the same code as
 * production without calling Gemini.
 */
type Handler = (response: http.ServerResponse) => void;

const defaults = {
    AI_FIRST_CHUNK_TIMEOUT_MS: env.AI_FIRST_CHUNK_TIMEOUT_MS,
    AI_RETRY_BASE_DELAY_MS: env.AI_RETRY_BASE_DELAY_MS,
    AI_RETRY_MAX_DELAY_MS: env.AI_RETRY_MAX_DELAY_MS,
    AI_RETRY_MAX_ATTEMPTS: env.AI_RETRY_MAX_ATTEMPTS,
    AI_TIMEOUT_MS: env.AI_TIMEOUT_MS,
};
const FIRST_CHUNK_LIMIT_MS = 150;

let server: http.Server;
let client: GeminiModelsClient;
/** What the server does for each request, in order. */
let script: Handler[] = [];
let requests = 0;
const open = new Set<http.ServerResponse>();

const sseChunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const partChunk = (text: string, extra = {}) => ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, ...extra }],
});
const startStream = (response: http.ServerResponse) => response.writeHead(200, { "Content-Type": "text/event-stream" });

const replyOk: Handler = (response) => {
    startStream(response);
    response.write(sseChunk({ ...partChunk('{"ok":'), modelVersion: "gemini-local" }));
    response.end(
        sseChunk({
            ...partChunk("true}", { finishReason: FinishReason.STOP }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0 },
        }),
    );
};
const replyStatus =
    (status: number): Handler =>
    (response) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: status, message: "busy", status: "UNAVAILABLE" } }));
    };
/** Never answers at all: the case a real stuck request looks like. */
const hangBeforeHeaders: Handler = () => undefined;
/** Accepts the request, then sends nothing. */
const hangAfterHeaders: Handler = (response) => {
    startStream(response);
    response.flushHeaders();
};
/** Starts replying, then goes quiet: only the attempt timeout can end this one. */
const hangMidReply: Handler = (response) => {
    startStream(response);
    response.write(sseChunk(partChunk('{"ok":')));
};

const request = { model: "gemini-test", contents: [{ role: "user", parts: [{ text: "hi" }] }] };
const call = (stream = true) => callGemini(client, request, { label: "Test", stream });

beforeAll(async () => {
    server = http.createServer((incoming, response) => {
        incoming.resume();
        open.add(response);
        response.on("close", () => open.delete(response));
        requests++;
        (script.shift() ?? replyStatus(500))(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new GoogleGenAI({ apiKey: "test-key", httpOptions: { baseUrl } });
});
afterAll(async () => {
    for (const response of open) response.destroy();
    await new Promise((resolve) => server.close(resolve));
    overrideEnv(defaults);
});
beforeEach(() => {
    script = [];
    requests = 0;
    overrideEnv({
        ...defaults,
        AI_FIRST_CHUNK_TIMEOUT_MS: FIRST_CHUNK_LIMIT_MS,
        AI_RETRY_BASE_DELAY_MS: 1,
        AI_RETRY_MAX_DELAY_MS: 5,
    });
});
afterEach(() => {
    for (const response of open) response.destroy();
});

describe("streamed Gemini requests (real SDK, local server)", () => {
    it("joins the chunks into one normal response and reports the first-chunk time", async () => {
        script = [replyOk];
        const { response, attempts, firstChunkMs } = await call();
        expect(response.text).toBe('{"ok":true}');
        expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
        expect(response.modelVersion).toBe("gemini-local");
        expect(response.usageMetadata?.promptTokenCount).toBe(10);
        expect(attempts).toBe(1);
        expect(firstChunkMs).toBeGreaterThanOrEqual(0);
    });

    it.each([
        ["before the response headers", hangBeforeHeaders],
        ["after the response headers", hangAfterHeaders],
    ])("gives up early on a request stuck %s, then succeeds on a new attempt", async (_name, hang) => {
        script = [hang, replyOk];
        const started = Date.now();
        const { response, attempts } = await call();
        expect(response.text).toBe('{"ok":true}');
        expect(attempts).toBe(2);
        expect(requests).toBe(2);
        // Far below AI_TIMEOUT_MS: the wait was the first-chunk limit, not the full attempt timeout.
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("stops after the attempt limit with a final error that says why", async () => {
        script = [hangAfterHeaders, hangAfterHeaders, hangAfterHeaders];
        await expect(call()).rejects.toMatchObject({
            code: "AI_ERROR",
            message: expect.stringMatching(/request timed out \(no first chunk within 0s\) persisted after 3 attempt/),
            errors: [{ retryable: false }],
        });
        expect(requests).toBe(3);
    });

    it("does not cut off a reply that has started: only the attempt timeout ends it", async () => {
        overrideEnv({ AI_TIMEOUT_MS: 500, AI_RETRY_MAX_ATTEMPTS: 1 });
        script = [hangMidReply];
        const started = Date.now();
        await expect(call()).rejects.toMatchObject({
            message: expect.stringMatching(/request timed out persisted after 1 attempt/),
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    });

    it("retries a 504 and then succeeds", async () => {
        script = [replyStatus(504), replyOk];
        const { attempts } = await call();
        expect(attempts).toBe(2);
    });

    it("reports a 504 that persists as a final error", async () => {
        script = [replyStatus(504), replyStatus(504), replyStatus(504)];
        await expect(call()).rejects.toMatchObject({
            message: expect.stringMatching(/gateway timeout \(504\) persisted after 3 attempt/),
            errors: [{ retryable: false }],
        });
    });

    it("keeps Google's explanation when a 429 persists", async () => {
        script = [replyStatus(429), replyStatus(429), replyStatus(429)];
        await expect(call()).rejects.toMatchObject({
            message: expect.stringMatching(/rate limit or quota \(429\) persisted after 3 .*Gemini says: busy/),
        });
    });

    it("does not retry a request Gemini refuses", async () => {
        script = [replyStatus(400)];
        await expect(call()).rejects.toMatchObject({ errors: [{ retryable: false }] });
        expect(requests).toBe(1);
    });
});

describe("requests that are not streamed (the planner)", () => {
    it("still retries a timeout, without a first-chunk limit", async () => {
        overrideEnv({ AI_TIMEOUT_MS: 300 });
        const reply: Handler = (response) => {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(partChunk("done", { finishReason: FinishReason.STOP })));
        };
        script = [hangBeforeHeaders, reply];
        const { response, attempts, firstChunkMs } = await call(false);
        expect(response.text).toBe("done");
        expect(attempts).toBe(2);
        expect(firstChunkMs).toBeUndefined();
    });

    it("uses generateContent, never the stream", async () => {
        const generateContent = vi.fn(async () => Object.assign(new GenerateContentResponse(), partChunk("x")));
        const generateContentStream = vi.fn();
        const fake = { models: { generateContent, generateContentStream } } as unknown as GeminiModelsClient;
        await callGemini(fake, request, { label: "Test" });
        expect(generateContent).toHaveBeenCalledTimes(1);
        expect(generateContentStream).not.toHaveBeenCalled();
    });
});

describe("mergeChunks", () => {
    const chunk = (fields: object) => Object.assign(new GenerateContentResponse(), fields);

    it("keeps the blocked prompt and an empty reply readable as they are", () => {
        const blocked = mergeChunks([chunk({ promptFeedback: { blockReason: "OTHER" } })]);
        expect(blocked.promptFeedback?.blockReason).toBe("OTHER");
        expect(blocked.candidates).toBeUndefined();
        expect(mergeChunks([]).candidates).toBeUndefined();
    });

    it("leaves thought parts out of the text, like a normal response", () => {
        const merged = mergeChunks([
            chunk({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }] }),
            chunk({ candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: FinishReason.STOP }] }),
        ]);
        expect(merged.text).toBe("answer");
        expect(merged.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    });
});
