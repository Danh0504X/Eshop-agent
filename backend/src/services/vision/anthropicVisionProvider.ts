import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildVisionUserText, VISION_SYSTEM_PROMPT } from "../../agent/prompts";
import { VisionAnalysisSchema } from "../../agent/schemas";
import { env } from "../../config/env";
import { ApiError } from "../../utils/errors";
import { aiError } from "./errors";
import type { VisionProvider, VisionRequest, VisionResponse } from "./types";

// Re-exported for existing imports until the legacy Anthropic provider is removed.
export { aiError };

/** The subset of the SDK client this provider uses, so tests can inject a deterministic fake. */
export type VisionClient = { beta: { messages: Pick<Anthropic["beta"]["messages"], "parse"> } };

export class AnthropicVisionProvider implements VisionProvider {
    readonly source = "ai" as const;
    private readonly client: VisionClient;

    constructor(client?: VisionClient) {
        this.client =
            client ??
            new Anthropic({ apiKey: env.AI_API_KEY, timeout: env.AI_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    }

    async analyze(request: VisionRequest): Promise<VisionResponse> {
        // Only the selected frames and a product checklist are sent; never whole videos or customer data.
        const content: Anthropic.Beta.BetaContentBlockParam[] = [];
        for (const frame of request.frames) {
            content.push({ type: "text", text: `Frame ${frame.frameId} at t=${frame.timestampSec.toFixed(1)}s` });
            content.push({
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: frame.jpeg.toString("base64") },
            });
        }
        content.push({
            type: "text",
            text: buildVisionUserText({
                ...request.expected,
                evidenceType: request.evidenceType,
                frameCount: request.frames.length,
            }),
        });

        let response;
        try {
            response = await this.client.beta.messages.parse(
                {
                    model: env.AI_MODEL,
                    max_tokens: 16000,
                    system: VISION_SYSTEM_PROMPT,
                    thinking: { type: "adaptive" },
                    output_config: { effort: env.AI_EFFORT, format: betaZodOutputFormat(VisionAnalysisSchema) },
                    ...(env.AI_REFUSAL_FALLBACK
                        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
                        : {}),
                    messages: [{ role: "user", content }],
                },
                { timeout: env.AI_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES },
            );
        } catch (error) {
            throw mapSdkError(error);
        }

        if (response.stop_reason === "refusal") {
            throw aiError(
                `Vision model declined the request (${response.stop_details?.category ?? "unspecified"})`,
                false,
            );
        }
        if (response.stop_reason === "max_tokens") {
            throw aiError("Vision model response was truncated", true);
        }
        if (!response.parsed_output) {
            throw aiError("Vision model returned no structured output", true);
        }
        return { analysis: response.parsed_output, model: response.model };
    }
}

const mapSdkError = (error: unknown): ApiError => {
    if (error instanceof Anthropic.APIConnectionTimeoutError) return aiError("Vision model request timed out", true);
    if (error instanceof Anthropic.AuthenticationError) return aiError("AI provider rejected the API key", false);
    if (error instanceof Anthropic.BadRequestError)
        return aiError(`AI provider rejected the request: ${error.message}`, false);
    if (error instanceof Anthropic.RateLimitError) return aiError("AI provider rate limit reached", true);
    if (error instanceof Anthropic.APIConnectionError) return aiError("Could not reach the AI provider", true);
    if (error instanceof Anthropic.APIError) return aiError(`AI provider error (${error.status ?? "unknown"})`, true);
    // JSON or schema failures while parsing the model output.
    if (error instanceof SyntaxError || (error instanceof Error && /pars|schema|json/i.test(error.message))) {
        return aiError(`Vision model returned malformed output: ${error.message}`, true);
    }
    return error instanceof ApiError ? error : aiError((error as Error)?.message ?? "Unknown AI error", true);
};
