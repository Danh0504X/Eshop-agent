import type { VisionAnalysis } from "../../agent/schemas";
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

export interface VisionProvider {
    readonly source: "ai" | "demo";
    analyze(request: VisionRequest): Promise<VisionResponse>;
}
