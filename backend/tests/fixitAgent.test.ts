import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInspection } from "../src/agent/fixitAgent";
import { DeterministicPlanner } from "../src/agent/planners/deterministicPlanner";
import { LlmPlanner, type PlannerClient } from "../src/agent/planners/llmPlanner";
import type { Planner } from "../src/agent/planners/types";
import { env, overrideEnv } from "../src/config/env";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import { Order } from "../src/models/Order";
import { setVisionProvider } from "../src/services/vision";
import { aiError } from "../src/services/vision/anthropicVisionProvider";
import { DemoVisionProvider } from "../src/services/vision/demoVisionProvider";
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
// LLM planner with a scripted (mocked) Anthropic client
// ---------------------------------------------------------------------------

type Block = { type: "tool_use"; id: string; name: string; input: unknown } | { type: "text"; text: string };
const toolUse = (id: string, name: string, input: unknown = {}): Block => ({ type: "tool_use", id, name, input });
const reply = (...content: Block[]) => ({
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    content,
    model: "claude-opus-5-5",
});

const scriptedClient = (script: Array<unknown | (() => unknown)>) => {
    const requests: Array<{ messages: unknown[]; tools: unknown[] }> = [];
    const create = vi.fn(async (params: { messages: unknown[]; tools: unknown[] }) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        const next = script.shift();
        if (next === undefined) throw new Error("script exhausted");
        return typeof next === "function" ? (next as () => unknown)() : next;
    });
    return { client: { beta: { messages: { create } } } as unknown as PlannerClient, requests, create };
};

describe("FixIt agent with the LLM planner (mocked client)", () => {
    it("follows tool calls (including parallel ones), feeds back results, and stores the narrative separately", async () => {
        spyProvider();
        const { order, inspection } = await setup({ scenario: "mismatch", planner: "llm" });
        await Order.updateOne(
            { _id: order._id },
            { $set: { customer: { name: "Pham Thi D", phone: "0933 222 111", address: "7 Tran Phu Street" } } },
        );
        const { client, requests } = scriptedClient([
            reply(toolUse("t1", "lookup_order", { orderId: order.orderId })),
            reply(toolUse("t2", "validate_evidence")),
            reply(
                toolUse("t3", "extract_frames", { evidenceType: "outbound" }),
                toolUse("t4", "extract_frames", { evidenceType: "return" }),
            ),
            reply(
                toolUse("t5", "analyze_item", { evidenceType: "outbound" }),
                toolUse("t6", "analyze_item", { evidenceType: "return" }),
            ),
            reply(toolUse("t7", "compare_items")),
            reply(toolUse("t7b", "verify_product_match")),
            reply(toolUse("t8", "validate_evidence")),
            reply(toolUse("t9", "build_claim_pack")),
            reply({
                type: "text",
                text: "Model and colour differ (frames OUT-05, RET-05). Draft claim awaits review.",
            }),
        ]);
        const result = await runInspection(inspection.id, { planner: new LlmPlanner(client) });

        expect(result.status).toBe("completed");
        expect(result.claimId).toBeDefined();
        expect(result.agentNarrative).toMatch(/Draft claim awaits review/);
        expect(result.summary).not.toEqual(result.agentNarrative);

        // Tool results go back in one user message per turn, matched by tool_use id.
        const third = requests[3].messages.at(-1) as {
            role: string;
            content: Array<{ type: string; tool_use_id?: string }>;
        };
        expect(third.role).toBe("user");
        expect(third.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)).toEqual(["t3", "t4"]);
        expect(JSON.stringify(requests)).not.toMatch(/Pham Thi D|0933|Tran Phu/);
    });

    it("feeds invalid tool arguments back as errors and lets the model correct itself", async () => {
        spyProvider();
        const { order, inspection } = await setup({ planner: "llm" });
        const { client, requests } = scriptedClient([
            reply(toolUse("bad", "lookup_order", { order: 42 })),
            reply(toolUse("t1", "lookup_order", { orderId: order.orderId })),
            reply({ type: "text", text: "Stopping." }),
        ]);
        const result = await runInspection(inspection.id, { planner: new LlmPlanner(client) });
        const feedback = requests[1].messages.at(-1) as { content: Array<{ is_error?: boolean; content?: string }> };
        expect(feedback.content[0].is_error).toBe(true);
        expect(feedback.content[0].content).toMatch(/INVALID_ARGUMENTS/);
        // Model quit early: the guardrail escalates instead of reporting success.
        expect(result.status).toBe("needs_review");
        expect(result.escalation?.reasons).toContain("WORKFLOW_ERROR");
    });

    it("blocks attempts to skip verification steps", async () => {
        spyProvider();
        const { inspection } = await setup({ scenario: "mismatch", planner: "llm" });
        const { client, requests } = scriptedClient([
            reply(toolUse("skip", "build_claim_pack")),
            reply({ type: "text", text: "Claim submitted." }),
        ]);
        const result = await runInspection(inspection.id, { planner: new LlmPlanner(client) });
        const feedback = requests[1].messages.at(-1) as { content: Array<{ content?: string }> };
        expect(feedback.content[0].content).toMatch(/TOOL_NOT_PERMITTED/);
        expect(result.claimId).toBeUndefined();
        expect(result.status).toBe("needs_review");
    });

    it("falls back to the deterministic planner when the AI API times out", async () => {
        spyProvider();
        const { inspection } = await setup({ scenario: "missing_item", expectedQuantity: 2, planner: "llm" });
        const { client } = scriptedClient([
            () => {
                throw new Anthropic.APIConnectionTimeoutError();
            },
        ]);
        const result = await runInspection(inspection.id, { planner: new LlmPlanner(client) });
        expect(result.plannerFallback).toBe(true);
        expect(
            result.agentLog.some((l) => l.kind === "guardrail" && /deterministic planner/.test(l.message ?? "")),
        ).toBe(true);
        expect(result.status).toBe("completed");
        expect(result.claimId).toBeDefined();
    });

    it("falls back when the planner response is malformed", async () => {
        spyProvider();
        const { inspection } = await setup({ planner: "llm" });
        const { client } = scriptedClient([{ stop_reason: "end_turn", content: "not-an-array" }]);
        const result = await runInspection(inspection.id, { planner: new LlmPlanner(client) });
        expect(result.plannerFallback).toBe(true);
        expect(result.status).toBe("completed");
    });

    it("stops at the iteration limit when the model loops", async () => {
        spyProvider();
        overrideEnv({ AGENT_MAX_ITERATIONS: 4 });
        const { order, inspection } = await setup({ planner: "llm" });
        const looping = Array.from({ length: 10 }, (_, i) =>
            reply(toolUse(`l${i}`, "lookup_order", { orderId: order.orderId })),
        );
        const { client, create } = scriptedClient(looping);
        const result = await runInspection(inspection.id, { planner: new LlmPlanner(client) });
        expect(create).toHaveBeenCalledTimes(4);
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
