import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runInspection } from "../src/agent/fixitAgent";
import { DeterministicPlanner } from "../src/agent/planners/deterministicPlanner";
import type { Planner } from "../src/agent/planners/types";
import { env, overrideEnv } from "../src/config/env";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import { Order } from "../src/models/Order";
import { setVisionProvider } from "../src/services/vision";
import { DemoVisionProvider } from "../src/services/vision/demoVisionProvider";
import { aiError } from "../src/services/vision/errors";
import type { VisionProvider } from "../src/services/vision/types";
import {
    connectTestDb,
    createMediaFromFile,
    createOrder,
    createUser,
    disconnectTestDb,
    makeVideo,
    type TestUser,
    useAdvisoryDemoProvider,
    type VideoKind,
} from "./helpers";

let owner: TestUser;
const defaults = {
    AGENT_MAX_ITERATIONS: env.AGENT_MAX_ITERATIONS,
    AGENT_MAX_TOOL_RETRIES: env.AGENT_MAX_TOOL_RETRIES,
    AGENT_TIMEOUT_MS: env.AGENT_TIMEOUT_MS,
};

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
});
afterAll(disconnectTestDb);
afterEach(() => {
    setVisionProvider(undefined);
    overrideEnv(defaults);
});

let seq = 0;
interface Setup {
    scenario?: string;
    outbound?: VideoKind | null;
    returned?: VideoKind | null;
    expectedQuantity?: number;
    planner?: "llm" | "deterministic";
}

const setup = async (opts: Setup = {}) => {
    seq++;
    const order = await createOrder({
        orderId: `ORD-AG-${seq}`,
        trackingCode: `TRK-AG-${seq}`,
        demoScenario: opts.scenario ?? "normal",
        expectedQuantity: opts.expectedQuantity ?? 1,
    });
    if (opts.outbound !== null)
        await createMediaFromFile(
            order,
            "outbound",
            await makeVideo(opts.outbound ?? "normal"),
            owner.principal.userId,
        );
    if (opts.returned !== null)
        await createMediaFromFile(order, "return", await makeVideo(opts.returned ?? "normal"), owner.principal.userId);
    const inspection = await Inspection.create({
        orderId: order.orderId,
        orderRef: order._id,
        shopId: order.shopId,
        warehouseId: order.warehouseId,
        task: `Inspect the returned package for order ${order.orderId}.`,
        analysisMode: "demo",
        planner: opts.planner ?? "deterministic",
        requestedBy: owner.principal.userId,
    });
    return { order, inspection };
};

const spyProvider = () => {
    const demo = new DemoVisionProvider();
    const provider: VisionProvider & { calls: number } = {
        source: "demo",
        calls: 0,
        analyze(req) {
            provider.calls++;
            return demo.analyze(req);
        },
        verifyProductMatch: (req) => demo.verifyProductMatch(req),
    };
    setVisionProvider(provider);
    return provider;
};

const inspect = async (opts: Setup = {}, planner?: Planner) => {
    const { inspection, order } = await setup(opts);
    const result = await runInspection(inspection.id, { planner: planner ?? new DeterministicPlanner() });
    const claim = result.claimId ? await Claim.findById(result.claimId) : null;
    return { result, claim, order: (await Order.findById(order._id))! };
};

describe("FixIt agent with the deterministic planner (demo analysis)", () => {
    it("case 1: a normal return completes without a claim", async () => {
        spyProvider();
        const { result, claim, order } = await inspect({ scenario: "normal" });
        expect(result.status).toBe("completed");
        expect(result.workflowState).toBe("COMPLETED");
        expect(claim).toBeNull();
        expect(result.recommendedAction).toMatch(/Process the return normally/);
        expect(result.summary).toMatch(/^\[DEMO MODE/);
        expect(order.inspectionStatus).toBe("completed");
        expect(result.stateHistory.map((s) => s.state)).toEqual([
            "RECEIVED",
            "ORDER_LOOKUP",
            "EVIDENCE_VALIDATION",
            "FRAME_EXTRACTION",
            "ITEM_ANALYSIS",
            "COMPARISON",
            "VERIFICATION",
            "COMPLETED",
        ]);
    });

    it("case 2: a missing item produces a draft claim pending approval", async () => {
        spyProvider();
        const { result, claim, order } = await inspect({ scenario: "missing_item", expectedQuantity: 2 });
        expect(result.status).toBe("completed");
        expect(claim?.status).toBe("pending_approval");
        expect(claim?.findings.some((f: { category: string }) => f.category === "quantity_mismatch")).toBe(true);
        expect(order.latestClaimId?.toString()).toBe(claim?.id);
        expect(result.recommendedAction).toMatch(/approve or reject/);
    });

    it("cases 3 and 4: model/colour mismatch and empty package produce claims", async () => {
        spyProvider();
        const mismatch = await inspect({ scenario: "mismatch" });
        expect(mismatch.claim?.findings.map((f: { category: string }) => f.category)).toEqual(
            expect.arrayContaining(["model_mismatch", "color_mismatch"]),
        );
        const empty = await inspect({ scenario: "empty_package" });
        expect(empty.claim?.findings[0]).toMatchObject({ category: "empty_package", severity: "critical" });
    });

    it("case 5: a minor dent completes with no claim", async () => {
        spyProvider();
        const { result, claim } = await inspect({ scenario: "minor_dent" });
        expect(result.status).toBe("completed");
        expect(claim).toBeNull();
        expect(result.recommendedAction).toMatch(/No claim recommended/);
    });

    it("case 6: missing evidence goes to human review without any AI analysis", async () => {
        const provider = spyProvider();
        const { result, claim, order } = await inspect({ returned: null });
        expect(result.status).toBe("needs_review");
        expect(result.reviewTask).toMatchObject({ status: "open" });
        expect(result.escalation?.reasons).toContain("EVIDENCE_MISSING");
        expect(provider.calls).toBe(0);
        expect(claim).toBeNull();
        expect(order.inspectionStatus).toBe("needs_review");
        expect(result.recommendedAction).toMatch(/Upload the missing evidence/);
    });

    it("case 7: dark or blurry footage is escalated before any AI call", async () => {
        const provider = spyProvider();
        const dark = await inspect({ returned: "dark" });
        expect(dark.result.status).toBe("needs_review");
        expect(dark.result.escalation?.reasons).toContain("POOR_VIDEO_QUALITY");
        const blurry = await inspect({ returned: "blurry" });
        expect(blurry.result.escalation?.reasons).toContain("POOR_VIDEO_QUALITY");
        expect(provider.calls).toBe(0);
    });

    it("case 8: evidence recorded for another order escalates before any AI call", async () => {
        const provider = spyProvider();
        const { order, inspection } = await setup();
        const other = await createOrder({ orderId: `ORD-AG-X${seq}`, trackingCode: `TRK-AG-X${seq}` });
        const foreign = await createMediaFromFile(other, "return", await makeVideo("normal"), owner.principal.userId);
        await Order.updateOne({ _id: order._id }, { $set: { returnMedia: [foreign._id] } });
        const result = await runInspection(inspection.id, { planner: new DeterministicPlanner() });
        expect(result.status).toBe("needs_review");
        expect(result.escalation?.reasons).toContain("ORDER_ID_MISMATCH");
        expect(result.claimId).toBeFalsy();
        expect(provider.calls).toBe(0);
    });

    it("a video uploaded without a label scan escalates before any AI call", async () => {
        const provider = spyProvider();
        const { order, inspection } = await setup({ returned: null });
        await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId, {
            scanned: false,
        });
        const result = await runInspection(inspection.id, { planner: new DeterministicPlanner() });
        expect(result.status).toBe("needs_review");
        expect(result.escalation?.reasons).toContain("EVIDENCE_NOT_SCANNED");
        expect(result.recommendedAction).toMatch(/Scan the order's label/);
        expect(provider.calls).toBe(0);
    });

    it("low model confidence escalates instead of concluding", async () => {
        spyProvider();
        const { result, claim } = await inspect({ scenario: "low_confidence" });
        expect(result.status).toBe("needs_review");
        expect(result.escalation?.reasons).toContain("LOW_CONFIDENCE");
        expect(result.confidence).toMatchObject({ calibrated: false, meetsThreshold: false });
        expect(claim).toBeNull();
    });

    it("discrepancies plus an advisory reason get both a draft claim and a review task", async () => {
        useAdvisoryDemoProvider();
        const { result, claim } = await inspect({ scenario: "mismatch" });
        expect(claim?.status).toBe("pending_approval");
        expect(result.status).toBe("needs_review");
        expect(result.escalation).toMatchObject({ blocking: false, reasons: ["INSTRUCTION_TEXT_IN_FOOTAGE"] });
    });

    it("escalates when the vision API keeps failing, after bounded retries", async () => {
        overrideEnv({ AGENT_MAX_TOOL_RETRIES: 1 });
        let calls = 0;
        setVisionProvider({
            source: "ai",
            analyze: async () => {
                calls++;
                throw aiError("Vision model request timed out", true);
            },
        });
        const { result } = await inspect();
        expect(result.status).toBe("needs_review");
        expect(calls).toBe(3); // outbound twice, plus the return video started at the same time
        expect(result.reviewTask?.reasons?.join(" ")).toMatch(/analyze_item failed/);
    });
});

// ---------------------------------------------------------------------------
// LLM planner limits (scripted planners; Gemini's own behaviour is covered in geminiPlanner.test.ts)
// ---------------------------------------------------------------------------

describe("FixIt agent with an LLM planner", () => {
    it("stops at the iteration limit when the model loops", async () => {
        spyProvider();
        overrideEnv({ AGENT_MAX_ITERATIONS: 4 });
        const { order, inspection } = await setup({ planner: "llm" });
        let turns = 0;
        const looping: Planner = {
            kind: "llm",
            name: "gemini",
            next: async () => {
                turns++;
                return {
                    type: "tool_calls",
                    calls: [{ id: `l${turns}`, name: "lookup_order", args: { orderId: order.orderId } }],
                };
            },
        };
        const result = await runInspection(inspection.id, { planner: looping });
        expect(turns).toBe(4);
        expect(result.agentLog.some((l) => /Iteration limit/.test(l.message ?? ""))).toBe(true);
        expect(result.status).toBe("needs_review");
    });

    it("bounds a hanging planner by the inspection deadline, records the fallback, and escalates", async () => {
        spyProvider();
        overrideEnv({ AGENT_TIMEOUT_MS: 800 });
        const { inspection } = await setup({ planner: "llm" });
        const hanging: Planner = { kind: "llm", name: "gemini", next: () => new Promise(() => {}) };
        const started = Date.now();
        const result = await runInspection(inspection.id, { planner: hanging });

        expect(Date.now() - started).toBeLessThan(5_000);
        expect(result.plannerFallback).toBe(true);
        expect(result.agentLog.some((l) => /Agent time limit/.test(l.message ?? ""))).toBe(true);
        expect(result.status).toBe("needs_review");
        expect(result.escalation?.reasons).toContain("WORKFLOW_ERROR");
    });
});
