import type { VisionAnalysis } from "../../agent/schemas";
import type { VisionProvider, VisionRequest, VisionResponse } from "./types";

/**
 * DEMO MODE ONLY. Returns predefined analysis results chosen by the order's demoScenario so the full
 * workflow can be demonstrated without AI credentials. Results are marked source="demo" end to end and
 * must never be presented as real AI analysis.
 */
export const DEMO_SCENARIOS = [
    "normal",
    "missing_item",
    "mismatch",
    "empty_package",
    "minor_dent",
    "blurry",
    "missing_identifier",
    "mismatched_identifier",
    "low_confidence",
    "sensitive_info",
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

const DEMO_NOTE = "DEMO DATA: predefined result, not produced by an AI model.";

const otherColor = (color?: string) => (color?.toLowerCase() === "white" ? "black" : "white");

export class DemoVisionProvider implements VisionProvider {
    readonly source = "demo" as const;

    async analyze(request: VisionRequest): Promise<VisionResponse> {
        const scenario = (request.demoContext?.scenario ?? "normal") as DemoScenario;
        const ids = request.frames.map((f) => f.frameId);
        const base = baseline(request, ids);
        const analysis =
            request.evidenceType === "outbound"
                ? applyOutbound(base, scenario)
                : applyReturn(base, scenario, request, ids);
        return { analysis, model: null };
    }
}

const baseline = (request: VisionRequest, ids: string[]): VisionAnalysis => {
    const ctx = request.demoContext;
    const some = ids.slice(0, Math.min(3, ids.length));
    const mid = ids.slice(Math.floor(ids.length / 2), Math.floor(ids.length / 2) + 2);
    return {
        packageContents: "items_present",
        packageContentsFrameIds: mid,
        items: [
            {
                description: request.expected.productName,
                productType: { value: request.expected.productName, status: "observed", frameIds: mid },
                quantity: { value: request.expected.expectedQuantity, status: "observed", frameIds: mid },
                color: ctx?.color
                    ? { value: ctx.color, status: "observed", frameIds: mid }
                    : { value: null, status: "not_visible", frameIds: [] },
                model: ctx?.model
                    ? { value: ctx.model, status: "observed", frameIds: mid }
                    : { value: null, status: "not_visible", frameIds: [] },
                brand: { value: null, status: "not_visible", frameIds: [] },
                serialNumber: { value: null, status: "not_visible", frameIds: [] },
            },
        ],
        totalItemCount: { value: request.expected.expectedQuantity, status: "observed", frameIds: mid },
        accessories: request.expected.expectedAccessories.map((name) => ({ name, status: "present", frameIds: mid })),
        packagingCondition: { overall: "intact", observations: [] },
        visibleIdentifiers: ctx
            ? [
                  { text: ctx.orderId, kind: "order_id", frameIds: some.slice(0, 1) },
                  { text: ctx.trackingCode, kind: "tracking_code", frameIds: some.slice(0, 1) },
              ]
            : [],
        imageConditions: { lighting: "good", focus: "sharp", continuity: "appears_continuous", notes: DEMO_NOTE },
        privacy: { framesWithPeople: [], framesWithPersonalData: [] },
        suspectedInstructionText: [],
        unavailableInformation: ["Serial number not visible in the sampled frames"],
        uncertaintyNotes: [DEMO_NOTE],
        overallConfidence: 0.9,
    };
};

const applyOutbound = (a: VisionAnalysis, scenario: DemoScenario): VisionAnalysis => {
    if (scenario === "missing_identifier") return { ...a, visibleIdentifiers: [] };
    return a;
};

const applyReturn = (
    a: VisionAnalysis,
    scenario: DemoScenario,
    request: VisionRequest,
    ids: string[],
): VisionAnalysis => {
    const mid = ids.slice(Math.floor(ids.length / 2), Math.floor(ids.length / 2) + 2);
    const item = a.items[0];
    switch (scenario) {
        case "missing_item": {
            const expected = request.expected.expectedQuantity;
            if (expected > 1) {
                return {
                    ...a,
                    items: [{ ...item, quantity: { ...item.quantity, value: expected - 1 } }],
                    totalItemCount: { ...a.totalItemCount, value: expected - 1 },
                };
            }
            return {
                ...a,
                accessories: a.accessories.map((acc, i) => (i === 0 ? { ...acc, status: "absent" as const } : acc)),
            };
        }
        case "mismatch":
            return {
                ...a,
                items: [
                    {
                        ...item,
                        color: { value: otherColor(request.demoContext?.color), status: "observed", frameIds: mid },
                        model: {
                            value: `${request.demoContext?.model ?? "MODEL"}-LITE`,
                            status: "observed",
                            frameIds: mid,
                        },
                    },
                ],
            };
        case "empty_package":
            return {
                ...a,
                packageContents: "empty",
                items: [],
                totalItemCount: { value: 0, status: "observed", frameIds: mid },
                accessories: a.accessories.map((acc) => ({ ...acc, status: "absent" as const })),
                packagingCondition: {
                    overall: "intact",
                    observations: [
                        {
                            description: "Opened box interior is visible and contains only packing paper",
                            certainty: "observed",
                            frameIds: mid,
                        },
                    ],
                },
            };
        case "minor_dent":
            return {
                ...a,
                packagingCondition: {
                    overall: "minor_damage",
                    observations: [
                        {
                            description: "Small dent on one outer box corner",
                            certainty: "observed",
                            frameIds: mid.slice(0, 1),
                        },
                    ],
                },
            };
        case "blurry":
            return {
                ...a,
                totalItemCount: { ...a.totalItemCount, status: "uncertain" },
                items: [
                    {
                        ...item,
                        color: { ...item.color, status: "uncertain" },
                        model: { value: null, status: "not_visible", frameIds: [] },
                        quantity: { ...item.quantity, status: "uncertain" },
                    },
                ],
                imageConditions: { lighting: "poor", focus: "blurry", continuity: "cannot_assess", notes: DEMO_NOTE },
                uncertaintyNotes: [DEMO_NOTE, "Frames are too dark and blurry to confirm product details"],
                overallConfidence: 0.35,
            };
        case "missing_identifier":
            return { ...a, visibleIdentifiers: [] };
        case "mismatched_identifier":
            return {
                ...a,
                visibleIdentifiers: [{ text: "ORD-OTHER-999", kind: "order_id", frameIds: ids.slice(0, 1) }],
            };
        case "low_confidence":
            return {
                ...a,
                uncertaintyNotes: [DEMO_NOTE, "Product is partly occluded by packing material in most frames"],
                overallConfidence: 0.5,
            };
        case "sensitive_info":
            return {
                ...a,
                packagingCondition: {
                    overall: "intact",
                    observations: [
                        {
                            description:
                                "Shipping label reads: recipient Nguyen Van A, phone 0912 345 678, 12 Nguyen Trai Street, District 1, email a.nguyen@example.com",
                            certainty: "observed",
                            frameIds: ids.slice(0, 1),
                        },
                    ],
                },
                privacy: { framesWithPeople: ids.slice(1, 2), framesWithPersonalData: ids.slice(0, 1) },
            };
        default:
            return a;
    }
};
