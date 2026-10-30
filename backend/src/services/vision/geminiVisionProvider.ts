import type { GenerateContentResponse, Part } from "@google/genai";
import type { z } from "zod";
import {
    buildProductMatchUserText,
    buildSegmentUserText,
    buildVisionUserText,
    PRODUCT_MATCH_SYSTEM_PROMPT,
    SEGMENT_SYSTEM_PROMPT,
    VISION_SYSTEM_PROMPT,
} from "../../agent/prompts";
import { ProductMatchSchema, SegmentObservationSchema, VisionAnalysisSchema } from "../../agent/schemas";
import { env } from "../../config/env";
import {
    assertUsableResponse,
    callGemini,
    createGeminiClient,
    toGeminiJsonSchema,
    usageOf,
    type GeminiModelsClient,
} from "../ai/gemini";
import { aiError } from "./errors";
import type {
    ProductMatchRequest,
    ProductMatchResponse,
    SegmentVisionRequest,
    SegmentVisionResponse,
    VisionFrame,
    VisionProvider,
    VisionRequest,
    VisionResponse,
} from "./types";

const LABEL = "Vision model";
const ANALYSIS_SCHEMA = toGeminiJsonSchema(VisionAnalysisSchema);
const SEGMENT_SCHEMA = toGeminiJsonSchema(SegmentObservationSchema);
const PRODUCT_MATCH_SCHEMA = toGeminiJsonSchema(ProductMatchSchema);

/** Each frame as its label followed by the inline JPEG, so the model can cite frame IDs. */
const frameParts = (frames: VisionFrame[]): Part[] =>
    frames.flatMap((frame) => [
        { text: `Frame ${frame.frameId} at t=${frame.timestampSec.toFixed(1)}s` },
        { inlineData: { mimeType: "image/jpeg", data: frame.jpeg.toString("base64") } },
    ]);

/** Parse and Zod-validate structured JSON output; any failure is a retryable AI error. */
const parseStructured = <T>(response: GenerateContentResponse, schema: z.ZodType<T>): T => {
    assertUsableResponse(response, LABEL);
    const text = response.text;
    if (!text) throw aiError(`${LABEL} returned no structured output`, true);
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw aiError(`${LABEL} returned malformed JSON`, true);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw aiError(`${LABEL} returned malformed output: ${issue?.path.join(".")} ${issue?.message}`, true);
    }
    return parsed.data;
};

/**
 * Gemini vision analysis. Sends only the selected frames (each labelled with its frame ID and timestamp)
 * plus the product checklist or question, and asks for JSON matching the shared Zod schemas. Results are
 * re-validated by visionService; nothing here relaxes a schema.
 */
export class GeminiVisionProvider implements VisionProvider {
    readonly source = "ai" as const;
    private client: GeminiModelsClient | undefined;

    constructor(client?: GeminiModelsClient) {
        this.client = client;
    }

    async analyze(request: VisionRequest): Promise<VisionResponse> {
        const parts: Part[] = [
            ...frameParts(request.frames),
            {
                text: buildVisionUserText({
                    ...request.expected,
                    evidenceType: request.evidenceType,
                    frameCount: request.frames.length,
                }),
            },
        ];
        this.client ??= createGeminiClient();
        const { response, attempts } = await callGemini(
            this.client,
            {
                model: env.GEMINI_VISION_MODEL,
                contents: [{ role: "user", parts }],
                config: {
                    systemInstruction: VISION_SYSTEM_PROMPT,
                    responseMimeType: "application/json",
                    responseJsonSchema: ANALYSIS_SCHEMA,
                },
            },
            { label: `${LABEL} (${request.evidenceType})`, deadlineMs: request.deadlineMs },
        );
        return {
            analysis: parseStructured(response, VisionAnalysisSchema),
            model: response.modelVersion ?? env.GEMINI_VISION_MODEL,
            usage: usageOf(response, attempts),
        };
    }

    async verifyProductMatch(request: ProductMatchRequest): Promise<ProductMatchResponse> {
        const parts: Part[] = [
            { text: "Frames from the OUTBOUND packing recording:" },
            ...frameParts(request.outboundFrames),
            { text: "Frames from the RETURN opening recording:" },
            ...frameParts(request.returnFrames),
            {
                text: buildProductMatchUserText({
                    outboundFrames: request.outboundFrames.length,
                    returnFrames: request.returnFrames.length,
                }),
            },
        ];
        this.client ??= createGeminiClient();
        const { response, attempts } = await callGemini(
            this.client,
            {
                model: env.GEMINI_VISION_MODEL,
                contents: [{ role: "user", parts }],
                config: {
                    systemInstruction: PRODUCT_MATCH_SYSTEM_PROMPT,
                    responseMimeType: "application/json",
                    responseJsonSchema: PRODUCT_MATCH_SCHEMA,
                },
            },
            { label: `${LABEL} (product match)`, deadlineMs: request.deadlineMs },
        );
        return {
            match: parseStructured(response, ProductMatchSchema),
            model: response.modelVersion ?? env.GEMINI_VISION_MODEL,
            usage: usageOf(response, attempts),
        };
    }

    async inspectSegment(request: SegmentVisionRequest): Promise<SegmentVisionResponse> {
        const parts: Part[] = [
            ...frameParts(request.frames),
            {
                text: buildSegmentUserText({
                    evidenceType: request.evidenceType,
                    startSec: request.startSec,
                    endSec: request.endSec,
                    question: request.question,
                    productName: request.productName,
                    frameCount: request.frames.length,
                }),
            },
        ];
        this.client ??= createGeminiClient();
        const { response, attempts } = await callGemini(
            this.client,
            {
                model: env.GEMINI_VISION_MODEL,
                contents: [{ role: "user", parts }],
                config: {
                    systemInstruction: SEGMENT_SYSTEM_PROMPT,
                    responseMimeType: "application/json",
                    responseJsonSchema: SEGMENT_SCHEMA,
                },
            },
            { label: `${LABEL} (${request.evidenceType})`, deadlineMs: request.deadlineMs },
        );
        return {
            observation: parseStructured(response, SegmentObservationSchema),
            model: response.modelVersion ?? env.GEMINI_VISION_MODEL,
            usage: usageOf(response, attempts),
        };
    }
}
