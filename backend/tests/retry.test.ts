import { ApiError as GenAiApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { classifyTransient, parseRetryDelayMs } from "../src/services/ai/gemini";
import { backoffDelay, retryWithBackoff, RetryExhaustedError } from "../src/utils/retry";

/** A fake clock: sleep() advances time instantly and records each wait. */
const fakeClock = (start = 1_000_000) => {
    let now = start;
    const waits: number[] = [];
    return {
        now: () => now,
        sleep: async (ms: number) => {
            waits.push(ms);
            now += ms;
        },
        waits,
    };
};

const transient = (status: number, retryAfter?: number) => () =>
    retryAfter === undefined ? { retry: status === 429 || status === 503 } : { retry: true, retryAfterMs: retryAfter };

describe("backoffDelay", () => {
    it("grows exponentially, is capped, and is jittered within [0, cap]", () => {
        expect(backoffDelay(1, 1000, 30_000, () => 1)).toBe(1000);
        expect(backoffDelay(3, 1000, 30_000, () => 1)).toBe(4000);
        expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
        expect(backoffDelay(3, 1000, 30_000, () => 0)).toBe(0);
        expect(backoffDelay(3, 1000, 30_000, () => 0.5)).toBe(2000);
    });
});

describe("retryWithBackoff", () => {
    it("retries a transient failure and reports the number of attempts", async () => {
        const clock = fakeClock();
        let calls = 0;
        const result = await retryWithBackoff(
            async () => {
                if (++calls < 3) throw new Error("busy");
                return "ok";
            },
            {
                maxAttempts: 3,
                baseDelayMs: 100,
                maxDelayMs: 1000,
                classify: () => ({ retry: true }),
                random: () => 1,
                ...clock,
            },
        );
        expect(result).toEqual({ value: "ok", attempts: 3 });
        expect(clock.waits).toEqual([100, 200]);
    });

    it("honours a server-requested delay as a minimum", async () => {
        const clock = fakeClock();
        let calls = 0;
        await retryWithBackoff(
            async () => {
                if (++calls === 1) throw new Error("rate limited");
                return "ok";
            },
            {
                maxAttempts: 2,
                baseDelayMs: 100,
                maxDelayMs: 1000,
                classify: transient(429, 17_000),
                random: () => 1,
                ...clock,
            },
        );
        expect(clock.waits).toEqual([17_000]);
    });

    it("rethrows non-retryable errors immediately without waiting", async () => {
        const clock = fakeClock();
        const boom = new Error("bad request");
        await expect(
            retryWithBackoff(
                async () => {
                    throw boom;
                },
                { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, classify: () => ({ retry: false }), ...clock },
            ),
        ).rejects.toBe(boom);
        expect(clock.waits).toEqual([]);
    });

    it("stops at the attempt limit", async () => {
        const clock = fakeClock();
        let calls = 0;
        const error = await retryWithBackoff(
            async () => {
                calls++;
                throw new Error("busy");
            },
            { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, classify: () => ({ retry: true }), ...clock },
        ).catch((e) => e);
        expect(error).toBeInstanceOf(RetryExhaustedError);
        expect(error).toMatchObject({ attempts: 3, reason: "max_attempts" });
        expect(calls).toBe(3);
    });

    it("never starts a wait that would end after the deadline", async () => {
        const clock = fakeClock();
        const error = await retryWithBackoff(
            async () => {
                throw new Error("rate limited");
            },
            {
                maxAttempts: 10,
                baseDelayMs: 1000,
                maxDelayMs: 60_000,
                deadline: clock.now() + 2_500,
                classify: () => ({ retry: true }),
                random: () => 1,
                ...clock,
            },
        ).catch((e) => e);
        // Waits of 1000 then 2000 would end at +3000 > +2500, so only the first wait happens.
        expect(clock.waits).toEqual([1000]);
        expect(error).toMatchObject({ reason: "deadline", attempts: 2 });
        expect(clock.now()).toBeLessThan(1_000_000 + 2_500);
    });

    it("gives up when the server asks for a delay longer than the remaining budget", async () => {
        const clock = fakeClock();
        const error = await retryWithBackoff(
            async () => {
                throw new Error("quota");
            },
            {
                maxAttempts: 5,
                baseDelayMs: 10,
                maxDelayMs: 100,
                deadline: clock.now() + 5_000,
                classify: transient(429, 60_000),
                ...clock,
            },
        ).catch((e) => e);
        expect(error).toMatchObject({ reason: "deadline", attempts: 1 });
        expect(clock.waits).toEqual([]);
    });
});

describe("Gemini transient error classification", () => {
    const body = (status: number, details?: unknown[], message = "busy") =>
        JSON.stringify({ error: { code: status, message, ...(details ? { details } : {}) } });

    it("reads Google's RetryInfo delay", () => {
        const error = new GenAiApiError({
            status: 429,
            message: body(429, [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" }]),
        });
        expect(parseRetryDelayMs(error)).toBe(17_000);
        expect(classifyTransient(error)).toEqual({ retry: true, retryAfterMs: 17_000 });
    });

    it("reads a 'retry in Ns' hint and returns undefined when the server says nothing", () => {
        expect(
            parseRetryDelayMs(
                new GenAiApiError({ status: 429, message: body(429, undefined, "Please retry in 2.5s.") }),
            ),
        ).toBe(2500);
        expect(parseRetryDelayMs(new GenAiApiError({ status: 503, message: body(503) }))).toBeUndefined();
    });

    it("retries only 429 and 503", () => {
        for (const status of [429, 503])
            expect(classifyTransient(new GenAiApiError({ status, message: "x" })).retry).toBe(true);
        for (const status of [400, 401, 403, 404, 500])
            expect(classifyTransient(new GenAiApiError({ status, message: "x" })).retry).toBe(false);
        expect(classifyTransient(new Error("timeout")).retry).toBe(false);
    });
});
