import type { SegmentObservation, VisionAnalysis } from "../../agent/schemas";
import type { AiUsage } from "../ai/gemini";

export interface VisionFrame {
    frameId: string;
    timestampSec: number;
    jpeg: Buffer;
}

export interface VisionRequest {
    evidenceType: "outbound" | "return";
    frames: VisionFrame[];
    /** Checklist sent to the model. Contains no customer personal data. */
    expected: {
        productName: string;
        productDescription?: string;
        expectedQuantity: number;
        expectedAccessories: string[];
    };
    /** Epoch ms the analysis must finish by (tool / inspection budget). */
    deadlineMs?: number;
    /** Only read by the demo provider to pick predefined results. Never sent to a real AI provider. */
    demoContext?: {
        scenario?: string;
        orderId: string;
        trackingCode: string;
        color?: string;
        model?: string;
    };
}

export interface VisionResponse {
    analysis: VisionAnalysis;
    model: string | null;
    /** Token usage reported by the provider (absent for demo data). */
    usage?: AiUsage;
}

export interface SegmentVisionRequest {
    evidenceType: "outbound" | "return";
    frames: VisionFrame[];
    startSec: number;
    endSec: number;
    question: string;
    productName: string;
    deadlineMs?: number;
    /** Only read by the demo provider. Never sent to a real AI provider. */
    demoContext?: { scenario?: string };
}

export interface SegmentVisionResponse {
    observation: SegmentObservation;
    model: string | null;
    usage?: AiUsage;
}

export interface VisionProvider {
    readonly source: "ai" | "demo";
    analyze(request: VisionRequest): Promise<VisionResponse>;
    /** Targeted look at a few frames with one question (adaptive re-inspection). Optional per provider. */
    inspectSegment?(request: SegmentVisionRequest): Promise<SegmentVisionResponse>;
}
