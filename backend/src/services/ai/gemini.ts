import { ApiError as GenAiApiError, FinishReason, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import { env } from "../../config/env";
import { aiError } from "../vision/errors";

/**
 * Shared Gemini plumbing for the vision provider and the planner: client creation, error classification,
 * response checks and Zod → JSON Schema conversion. Domain logic stays out of this file.
 */

/** The subset of the SDK the app calls, so tests can inject a deterministic fake. */
export type GeminiModelsClient = { models: Pick<GoogleGenAI["models"], "generateContent"> };

export const createGeminiClient = (): GeminiModelsClient => {
    if (!env.GEMINI_API_KEY) throw aiError("GEMINI_API_KEY is not configured", false);
    return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
};

export interface AiUsage {
    promptTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
}

export const usageOf = (response: GenerateContentResponse): AiUsage => ({
    promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    thoughtsTokens: response.usageMetadata?.thoughtsTokenCount ?? 0,
});

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

/** Map SDK / network failures onto AI errors with a retryable hint. */
export const mapGeminiError = (error: unknown, label: string): ApiErrorLike => {
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
        return aiError(`${label}: Gemini error (${status})`, false);
    }
    if (error instanceof Error) {
        if (
            error.name === "AbortError" ||
            error.name === "TimeoutError" ||
            /timed? ?out|aborted/i.test(error.message)
        ) {
            return aiError(`${label} request timed out`, true);
        }
        if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(error.message)) {
            return aiError(`${label}: could not reach Gemini`, true);
        }
    }
    return aiError(`${label}: unexpected error: ${error instanceof Error ? error.message : String(error)}`, true);
};

type ApiErrorLike = ReturnType<typeof aiError>;

/** JSON Schema for Gemini's `responseJsonSchema` / `parametersJsonSchema` (the `$schema` keyword is dropped). */
export const toGeminiJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
    return rest;
};

/** Per-request transport options. SDK-level retries stay off: the agent's tool registry owns bounded retries. */
export const requestOptions = () => ({ httpOptions: { timeout: env.AI_TIMEOUT_MS } });
