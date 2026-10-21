import type { Part } from "@google/genai";
import { buildVisionUserText, VISION_SYSTEM_PROMPT } from "../../agent/prompts";
import { VisionAnalysisSchema } from "../../agent/schemas";
import { env } from "../../config/env";
import {
    assertUsableResponse,
    createGeminiClient,
    mapGeminiError,
    requestOptions,
    toGeminiJsonSchema,
    usageOf,
    type GeminiModelsClient,
} from "../ai/gemini";
import { aiError } from "./errors";
import type { VisionProvider, VisionRequest, VisionResponse } from "./types";

const LABEL = "Vision model";
const RESPONSE_SCHEMA = toGeminiJsonSchema(VisionAnalysisSchema);

/**
 * Gemini vision analysis. Sends only the selected frames (each labelled with its frame ID and timestamp)
 * plus the product checklist, and asks for JSON matching VisionAnalysisSchema. The result is still
 * re-validated by visionService; nothing here relaxes the schema.
 */
export class GeminiVisionProvider implements VisionProvider {
    readonly source = "ai" as const;
    private client: GeminiModelsClient | undefined;

    constructor(client?: GeminiModelsClient) {
        this.client = client;
    }

    async analyze(request: VisionRequest): Promise<VisionResponse> {
        const parts: Part[] = [];
        for (const frame of request.frames) {
            parts.push({ text: `Frame ${frame.frameId} at t=${frame.timestampSec.toFixed(1)}s` });
            parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.jpeg.toString("base64") } });
        }
        parts.push({
            text: buildVisionUserText({
                ...request.expected,
                evidenceType: request.evidenceType,
                frameCount: request.frames.length,
            }),
        });

        this.client ??= createGeminiClient();
        let response;
        try {
            response = await this.client.models.generateContent({
                model: env.GEMINI_VISION_MODEL,
                contents: [{ role: "user", parts }],
                config: {
                    ...requestOptions(),
                    systemInstruction: VISION_SYSTEM_PROMPT,
                    responseMimeType: "application/json",
                    responseJsonSchema: RESPONSE_SCHEMA,
                },
            });
        } catch (error) {
            throw mapGeminiError(error, LABEL);
        }

        assertUsableResponse(response, LABEL);
        const text = response.text;
        if (!text) throw aiError(`${LABEL} returned no structured output`, true);
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            throw aiError(`${LABEL} returned malformed JSON`, true);
        }
        const parsed = VisionAnalysisSchema.safeParse(json);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw aiError(`${LABEL} returned malformed output: ${issue?.path.join(".")} ${issue?.message}`, true);
        }
        return {
            analysis: parsed.data,
            model: response.modelVersion ?? env.GEMINI_VISION_MODEL,
            usage: usageOf(response),
        };
    }
}
