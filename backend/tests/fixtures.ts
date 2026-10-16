import type { AnalysisRecord } from "../src/agent/schemas";
import { DemoVisionProvider, type DemoScenario } from "../src/services/vision/demoVisionProvider";

export const ORDER_CTX = {
    orderId: "ORD-T1",
    trackingCode: "TRK-T1",
    productName: "Wireless Headphones",
    expectedQuantity: 1,
    expectedAccessories: ["charging cable"],
    color: "black",
    model: "WH-100",
};

const frames = (prefix: string) =>
    Array.from({ length: 8 }, (_, i) => ({
        frameId: `${prefix}-${String(i + 1).padStart(2, "0")}`,
        timestampSec: i * 0.5 + 0.25,
        jpeg: Buffer.alloc(0),
    }));

/** Deterministic analysis record built from the predefined demo scenarios. */
export const demoRecord = async (
    scenario: DemoScenario,
    evidenceType: "outbound" | "return",
    ctx: Partial<typeof ORDER_CTX> = {},
): Promise<AnalysisRecord> => {
    const c = { ...ORDER_CTX, ...ctx };
    const f = frames(evidenceType === "outbound" ? "OUT" : "RET");
    const { analysis } = await new DemoVisionProvider().analyze({
        evidenceType,
        frames: f,
        expected: {
            productName: c.productName,
            expectedQuantity: c.expectedQuantity,
            expectedAccessories: c.expectedAccessories,
        },
        demoContext: { scenario, orderId: c.orderId, trackingCode: c.trackingCode, color: c.color, model: c.model },
    });
    return {
        mediaId: `${evidenceType}-media`,
        evidenceType,
        source: "demo",
        model: null,
        framesAnalyzed: f.map(({ frameId, timestampSec }) => ({ frameId, timestampSec })),
        analyzedAt: new Date().toISOString(),
        result: analysis,
        validationNotes: [],
    };
};

export const demoPair = async (scenario: DemoScenario, ctx: Partial<typeof ORDER_CTX> = {}) => ({
    outbound: await demoRecord(scenario, "outbound", ctx),
    returned: await demoRecord(scenario, "return", ctx),
});
