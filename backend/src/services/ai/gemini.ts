import {
    ApiError as GenAiApiError,
    FinishReason,
    GenerateContentResponse,
    GoogleGenAI,
    ThinkingLevel,
    type GenerateContentParameters,
} from "@google/genai";
import { z } from "zod";
import { env } from "../../config/env";
import { ApiError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { retryWithBackoff, RetryExhaustedError, type RetryDecision } from "../../utils/retry";
import { trace } from "../../agent/agentTrace";
import { aiError } from "../vision/errors";

/**
 * Shared Gemini plumbing for the vision provider and the planner: client creation, error classification,
 * response checks and Zod → JSON Schema conversion. Domain logic stays out of this file.
 */

/** The subset of the SDK the app calls, so tests can inject a deterministic fake. */
export type GeminiModelsClient = { models: Pick<GoogleGenAI["models"], "generateContent" | "generateContentStream"> };

export const createGeminiClient = (): GeminiModelsClient => {
    if (!env.GEMINI_API_KEY) throw aiError("GEMINI_API_KEY is not configured", false);
    return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
};

export interface AiUsage {
    promptTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
    /** HTTP attempts made for this one logical request (1 = no transport retry). */
    apiAttempts: number;
    /** Streamed requests: how long the attempt that succeeded waited for Gemini's first chunk. */
    firstChunkMs?: number;
}

export const usageOf = (response: GenerateContentResponse, apiAttempts = 1, firstChunkMs?: number): AiUsage => ({
    promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    thoughtsTokens: response.usageMetadata?.thoughtsTokenCount ?? 0,
    apiAttempts,
    ...(firstChunkMs === undefined ? {} : { firstChunkMs }),
});

/** Gemini sent nothing within the first-chunk limit: the request is stuck, so a new one is a better bet. */
export class GeminiStallError extends Error {
    constructor(ms: number) {
        super(`no first chunk within ${Math.round(ms / 1000)}s`);
        this.name = "GeminiStallError";
    }
}

/** Finish reasons that mean the model declined or was blocked: retrying the same request will not help. */
const BLOCKED: ReadonlySet<string> = new Set([
    FinishReason.SAFETY,
    FinishReason.BLOCKLIST,
    FinishReason.PROHIBITED_CONTENT,
    FinishReason.SPII,
    FinishReason.RECITATION,
    FinishReason.IMAGE_SAFETY,
    FinishReason.IMAGE_PROHIBITED_CONTENT,
]);

/**
 * Reject responses that cannot be trusted before their content is read.
 * `label` names the caller in error messages ("Vision model", "Planner").
 */
export const assertUsableResponse = (response: GenerateContentResponse, label: string): void => {
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) throw aiError(`${label} request was blocked (${blockReason})`, false);
    const candidate = response.candidates?.[0];
    if (!candidate) throw aiError(`${label} returned no candidates`, true);
    const reason = candidate.finishReason;
    if (reason && BLOCKED.has(reason)) throw aiError(`${label} declined the request (${reason})`, false);
    if (reason === FinishReason.MAX_TOKENS) throw aiError(`${label} response was truncated`, true);
    if (reason === FinishReason.MALFORMED_FUNCTION_CALL)
        throw aiError(`${label} produced a malformed function call`, true);
};

/** The SDK puts Google's JSON error body in `message`; keep only its human-readable text. */
const googleMessage = (error: GenAiApiError): string => {
    try {
        const body = JSON.parse(error.message) as { error?: { message?: string } };
        return (body.error?.message ?? error.message).slice(0, 300);
    } catch {
        return error.message.slice(0, 300);
    }
};

/**
 * Server-requested wait, from Google's RetryInfo detail (`"retryDelay": "17s"`) or a "retry in 17.2s" hint.
 * Returns undefined when the server did not say.
 */
export const parseRetryDelayMs = (error: GenAiApiError): number | undefined => {
    try {
        const body = JSON.parse(error.message) as { error?: { details?: Array<Record<string, unknown>> } };
        const info = body.error?.details?.find((d) => String(d["@type"] ?? "").endsWith("google.rpc.RetryInfo"));
        const delay = typeof info?.retryDelay === "string" ? /^([\d.]+)s$/.exec(info.retryDelay) : null;
        if (delay) return Math.round(Number(delay[1]) * 1000);
    } catch {
        /* not a JSON body */
    }
    const hint = /retry in ([\d.]+)\s*s/i.exec(error.message);
    return hint ? Math.round(Number(hint[1]) * 1000) : undefined;
};

/** A stalled stream, or the SDK aborting the attempt when its time runs out. */
const isTimeout = (error: unknown): boolean =>
    error instanceof GeminiStallError ||
    (error instanceof Error &&
        !(error instanceof ApiError) &&
        (error.name === "AbortError" || error.name === "TimeoutError" || /timed? ?out|aborted/i.test(error.message)));

const TRANSIENT_STATUSES = [429, 503, 504];

/** Rate limiting, temporary unavailability and requests that took too long are retried at the transport level. */
export const classifyTransient = (error: unknown): RetryDecision => {
    if (error instanceof GenAiApiError) {
        return TRANSIENT_STATUSES.includes(error.status)
            ? { retry: true, retryAfterMs: parseRetryDelayMs(error) }
            : { retry: false };
    }
    return { retry: isTimeout(error) };
};

const persistentFailure = (cause: unknown): string => {
    if (!(cause instanceof GenAiApiError)) {
        return `request timed out${cause instanceof GeminiStallError ? ` (${cause.message})` : ""}`;
    }
    if (cause.status === 429) return "rate limit or quota (429)";
    if (cause.status === 504) return "gateway timeout (504)";
    return `service unavailable (${cause.status})`;
};

/** Map SDK / network failures onto AI errors with a retryable hint. */
export const mapGeminiError = (error: unknown, label: string): ApiErrorLike => {
    if (error instanceof ApiError) return error;
    if (error instanceof RetryExhaustedError) {
        // Backoff already ran. Marking this final stops the agent from compounding retries; it escalates instead.
        // Google's text says which limit was hit (per minute, per day, plan), which decides what to do about it.
        const says =
            error.cause instanceof GenAiApiError && error.cause.status === 429
                ? ` Gemini says: ${googleMessage(error.cause)}`
                : "";
        return aiError(
            `${label}: Gemini ${persistentFailure(error.cause)} persisted after ${error.attempts} attempt(s); ${error.reason === "deadline" ? "inspection time budget exhausted" : "retry limit reached"}.${says}`,
            false,
        );
    }
    if (error instanceof GenAiApiError) {
        const status = error.status;
        if (status === 429) return aiError(`${label}: Gemini rate limit or quota reached`, true);
        if (status === 401 || status === 403) return aiError(`${label}: Gemini rejected the API key`, false);
        // Google's message names the replacement when a model is retired, so it is kept verbatim.
        if (status === 404)
            return aiError(
                `${label}: model not found. Check GEMINI_*_MODEL (npm run gemini:models). Gemini says: ${googleMessage(error)}`,
                false,
            );
        if (status === 400) return aiError(`${label}: Gemini rejected the request: ${googleMessage(error)}`, false);
        if (status >= 500) return aiError(`${label}: Gemini service error (${status})`, true);
        if (status === 402)
            return aiError(`${label}: Gemini payment required (402). Gemini says: ${googleMessage(error)}`, false);
        return aiError(`${label}: Gemini error (${status}): ${googleMessage(error)}`, false);
    }
    if (error instanceof Error && /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(error.message)) {
        return aiError(`${label}: could not reach Gemini`, true);
    }
    return aiError(`${label}: unexpected error: ${error instanceof Error ? error.message : String(error)}`, true);
};

type ApiErrorLike = ReturnType<typeof aiError>;

/** JSON Schema for Gemini's `responseJsonSchema` / `parametersJsonSchema` (the `$schema` keyword is dropped). */
export const toGeminiJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
    return rest;
};

/** Keep a little headroom so a request never ends after the caller's deadline. */
const DEADLINE_SAFETY_MS = 2_000;
/** Below this, a request is unlikely to finish; fail fast instead of starting it. */
export const MIN_REQUEST_MS = 5_000;

/** Per-attempt timeout: AI_TIMEOUT_MS, shortened to fit the remaining time budget. */
export const requestTimeoutMs = (deadlineMs: number | undefined, label: string, now = Date.now()): number => {
    if (deadlineMs === undefined) return env.AI_TIMEOUT_MS;
    const remaining = deadlineMs - now - DEADLINE_SAFETY_MS;
    if (remaining < MIN_REQUEST_MS)
        throw aiError(`${label}: inspection time budget exhausted before calling Gemini`, false);
    return Math.min(env.AI_TIMEOUT_MS, remaining);
};

/** Thinking level verified against the configured model (see .env.example); unset = model default. */
const thinkingConfig = () =>
    env.GEMINI_THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: ThinkingLevel[env.GEMINI_THINKING_LEVEL] } } : {};

export interface GeminiCallOptions {
    /** Names the caller in errors and logs ("Vision model", "Planner"). */
    label: string;
    /** Epoch ms the whole operation must finish by (tool / inspection budget). */
    deadlineMs?: number;
    /**
     * Read the reply as a stream, so a request that sends nothing can be given up early. Not for the planner: its
     * turns are sent back verbatim with their thought signatures, so they must stay exactly as Gemini returned them.
     */
    stream?: boolean;
}

/** One reply built from its stream chunks; `text`, `usageMetadata` and the rest read as in a normal response. */
export const mergeChunks = (chunks: GenerateContentResponse[]): GenerateContentResponse => {
    const merged = new GenerateContentResponse();
    merged.promptFeedback = chunks.find((c) => c.promptFeedback)?.promptFeedback;
    merged.modelVersion = chunks.find((c) => c.modelVersion)?.modelVersion;
    merged.usageMetadata = chunks.flatMap((c) => c.usageMetadata ?? []).at(-1);
    const candidates = chunks.flatMap((c) => c.candidates?.[0] ?? []);
    if (candidates.length) {
        merged.candidates = [
            {
                ...candidates.at(-1),
                content: { role: "model", parts: candidates.flatMap((c) => c.content?.parts ?? []) },
                finishReason: candidates.flatMap((c) => c.finishReason ?? []).at(-1),
            },
        ];
    }
    return merged;
};

/** One streamed attempt. It is aborted if no chunk arrives in time; the attempt timeout still bounds the rest. */
const streamAttempt = async (
    client: GeminiModelsClient,
    params: GenerateContentParameters,
    firstChunkLimitMs: number,
    label: string,
): Promise<{ response: GenerateContentResponse; firstChunkMs: number }> => {
    const started = Date.now();
    const controller = new AbortController();
    let stalled = false;
    const stallTimer = setTimeout(() => {
        stalled = true;
        controller.abort();
    }, firstChunkLimitMs);
    const chunks: GenerateContentResponse[] = [];
    let firstChunkMs = 0;
    try {
        const stream = await client.models.generateContentStream({
            ...params,
            config: { ...params.config, abortSignal: controller.signal },
        });
        for await (const chunk of stream) {
            if (!chunks.length) {
                clearTimeout(stallTimer);
                firstChunkMs = Date.now() - started;
                trace(`  ... Gemini ${label} first chunk after ${(firstChunkMs / 1000).toFixed(1)}s`);
            }
            chunks.push(chunk);
        }
        return { response: mergeChunks(chunks), firstChunkMs };
    } catch (error) {
        throw stalled ? new GeminiStallError(firstChunkLimitMs) : error;
    } finally {
        clearTimeout(stallTimer);
    }
};

/**
 * The single entry point for Gemini requests: per-attempt timeout bounded by the deadline, exponential backoff
 * with jitter for 429/503/504 and for requests that took too long (honouring RetryInfo), thinking level, and error
 * mapping. SDK-level retries stay off.
 */
export const callGemini = async (
    client: GeminiModelsClient,
    params: GenerateContentParameters,
    options: GeminiCallOptions,
): Promise<{ response: GenerateContentResponse; attempts: number; firstChunkMs?: number }> => {
    const started = Date.now();
    const images = countImages(params.contents);
    trace(
        `  ... Gemini ${options.label} request -> ${params.model}${images ? ` with ${images} frame image(s)` : ""} (waiting; per-attempt timeout ${Math.round(requestTimeoutMsSafe(options.deadlineMs) / 1000)}s)`,
    );
    try {
        const { value, attempts } = await retryWithBackoff(
            async (): Promise<{ response: GenerateContentResponse; firstChunkMs?: number }> => {
                const timeout = requestTimeoutMs(options.deadlineMs, options.label);
                const request = {
                    ...params,
                    config: { ...thinkingConfig(), ...params.config, httpOptions: { timeout } },
                };
                if (options.stream) {
                    const limit = Math.min(env.AI_FIRST_CHUNK_TIMEOUT_MS, timeout);
                    return streamAttempt(client, request, limit, options.label);
                }
                return { response: await client.models.generateContent(request) };
            },
            {
                maxAttempts: env.AI_RETRY_MAX_ATTEMPTS,
                baseDelayMs: env.AI_RETRY_BASE_DELAY_MS,
                maxDelayMs: env.AI_RETRY_MAX_DELAY_MS,
                deadline: options.deadlineMs === undefined ? undefined : options.deadlineMs - MIN_REQUEST_MS,
                classify: classifyTransient,
                onRetry: ({ attempt, delayMs, error }) => {
                    const status = error instanceof GenAiApiError ? error.status : undefined;
                    logger.warn("Gemini transient error; backing off", {
                        label: options.label,
                        attempt,
                        delayMs,
                        status,
                    });
                    const reason = status ?? (error instanceof GeminiStallError ? error.message : "timeout");
                    trace(
                        `  ... Gemini ${options.label} got ${reason}; retry ${attempt + 1} in ${(delayMs / 1000).toFixed(1)}s`,
                    );
                },
            },
        );
        const usage = usageOf(value.response, attempts);
        trace(
            `  ... Gemini ${options.label} replied in ${((Date.now() - started) / 1000).toFixed(1)}s (tokens in ${usage.promptTokens}, out ${usage.outputTokens}, thinking ${usage.thoughtsTokens}; attempts ${attempts})`,
        );
        return { response: value.response, attempts, firstChunkMs: value.firstChunkMs };
    } catch (error) {
        const mapped = mapGeminiError(error, options.label);
        trace(
            `  ... Gemini ${options.label} FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${mapped.message}`,
        );
        throw mapped;
    }
};

/** Number of inline images in a request, for the trace line. */
const countImages = (contents: GenerateContentParameters["contents"]): number =>
    Array.isArray(contents)
        ? contents.reduce<number>(
              (n, c) =>
                  n +
                  (typeof c === "object" && c !== null && "parts" in c && Array.isArray(c.parts)
                      ? c.parts.filter((p) => typeof p === "object" && p !== null && "inlineData" in p).length
                      : 0),
              0,
          )
        : 0;

/** requestTimeoutMs without throwing, for display only. */
const requestTimeoutMsSafe = (deadlineMs: number | undefined): number => {
    try {
        return requestTimeoutMs(deadlineMs, "trace");
    } catch {
        return 0;
    }
};
