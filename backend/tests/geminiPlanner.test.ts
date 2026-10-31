import { FinishReason } from "@google/genai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInspection } from "../src/agent/fixitAgent";
import { GeminiPlanner } from "../src/agent/planners/geminiPlanner";
import { env, overrideEnv } from "../src/config/env";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import type { GeminiModelsClient } from "../src/services/ai/gemini";
import { setVisionProvider } from "../src/services/vision";
import { DemoVisionProvider } from "../src/services/vision/demoVisionProvider";
import {
    connectTestDb,
    createMediaFromFile,
    createOrder,
    createUser,
    disconnectTestDb,
    makeVideo,
    type TestUser,
} from "./helpers";

let owner: TestUser;
const defaults = {
    AI_RETRY_BASE_DELAY_MS: env.AI_RETRY_BASE_DELAY_MS,
    AI_RETRY_MAX_DELAY_MS: env.AI_RETRY_MAX_DELAY_MS,
};

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
    overrideEnv({ AI_RETRY_BASE_DELAY_MS: 1, AI_RETRY_MAX_DELAY_MS: 5 });
});
afterAll(async () => {
    overrideEnv(defaults);
    await disconnectTestDb();
});
afterEach(() => setVisionProvider(undefined));

let seq = 0;
const setup = async (opts: { scenario?: string; withReturn?: boolean; customer?: Record<string, string> } = {}) => {
    seq++;
    const order = await createOrder({
        orderId: `ORD-GP-${seq}`,
        trackingCode: `TRK-GP-${seq}`,
        demoScenario: opts.scenario ?? "normal",
        ...(opts.customer ? { customer: opts.customer } : {}),
    });
    await createMediaFromFile(order, "outbound", await makeVideo("normal"), owner.principal.userId);
    if (opts.withReturn !== false) {
        await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
    }
    const inspection = await Inspection.create({
        orderId: order.orderId,
        orderRef: order._id,
        shopId: order.shopId,
        warehouseId: order.warehouseId,
        task: `Inspect the returned package for order ${order.orderId}.`,
        analysisMode: "demo",
        planner: "llm",
        requestedBy: owner.principal.userId,
    });
    setVisionProvider(new DemoVisionProvider());
    return { order, inspection };
};

// --- Scripted Gemini responses -------------------------------------------------------------------------------

type Call = { name: string; args?: Record<string, unknown>; id?: string };
/** A model turn: optional rationale text, function calls, and a thought signature on the first call (as Gemini 3 does). */
const turn = (text: string | null, ...calls: Call[]) => {
    const parts: Array<Record<string, unknown>> = [];
    if (text) parts.push({ text });
    calls.forEach((c, i) =>
        parts.push({
            functionCall: { ...(c.id ? { id: c.id } : {}), name: c.name, args: c.args ?? {} },
            ...(i === 0 ? { thoughtSignature: `sig-${c.name}-${i}` } : {}),
        }),
    );
    return { candidates: [{ content: { role: "model", parts }, finishReason: FinishReason.STOP }] };
};
const final = (text: string) => ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: FinishReason.STOP }],
});

interface Request {
    contents: Array<{ role: string; parts: Array<Record<string, any>> }>;
    config: { tools: Array<{ functionDeclarations: Array<{ name: string; parametersJsonSchema: unknown }> }> };
}

const scriptedGemini = (script: Array<unknown | (() => unknown)>) => {
    const requests: Request[] = [];
    const generateContent = vi.fn(async (params: unknown) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        const next = script.shift();
        if (next === undefined) throw new Error("script exhausted");
        return typeof next === "function" ? (next as () => unknown)() : next;
    });
    return { client: { models: { generateContent } } as unknown as GeminiModelsClient, requests, generateContent };
};

const responsesIn = (request: Request) =>
    request.contents.at(-1)!.parts.map((p) => p.functionResponse as { id?: string; name: string; response: any });

// --- Tests -----------------------------------------------------------------------------------------------------

describe("GeminiPlanner function calling", () => {
    it("drives a full inspection from Gemini's own tool choices and preserves model turns verbatim", async () => {
        const { order, inspection } = await setup({
            scenario: "mismatch",
            customer: { name: "Vu Thi F", phone: "0977 123 456", address: "88 Ly Thuong Kiet Street" },
        });
        const { client, requests } = scriptedGemini([
            turn("Start by locating the order.", { id: "c1", name: "lookup_order", args: { orderId: order.orderId } }),
            turn("Check both videos exist before spending effort.", { id: "c2", name: "validate_evidence" }),
            turn(
                "Extract frames from both videos.",
                { id: "c3", name: "extract_frames", args: { evidenceType: "outbound" } },
                { id: "c4", name: "extract_frames", args: { evidenceType: "return" } },
            ),
            turn(
                "Analyse both videos.",
                { id: "c5", name: "analyze_item", args: { evidenceType: "outbound" } },
                { id: "c6", name: "analyze_item", args: { evidenceType: "return" } },
            ),
            turn("Compare the analyses.", { id: "c7", name: "compare_items" }),
            turn("The colour descriptions differ: look at both videos.", { id: "c7b", name: "verify_product_match" }),
            turn("Verify evidence before any claim.", { id: "c8", name: "validate_evidence" }),
            turn("Two material discrepancies and no blocking issues: draft the claim.", {
                id: "c9",
                name: "build_claim_pack",
            }),
            final("Model and colour differ (OUT-05, RET-05). Draft claim awaits human review."),
        ]);
        const planner = new GeminiPlanner(client);
        const result = await runInspection(inspection.id, { planner });

        expect(result.status).toBe("completed");
        expect(await Claim.countDocuments({ inspectionId: inspection._id })).toBe(1);
        expect(result.agentNarrative).toMatch(/Draft claim awaits human review/);
        expect(result.summary).not.toEqual(result.agentNarrative);

        // Tools are declared from the registry (planner-visible only) with JSON schemas.
        const declared = requests[0].config.tools[0].functionDeclarations;
        expect(declared.find((d) => d.name === "lookup_order")?.parametersJsonSchema).toMatchObject({ type: "object" });

        // The model turn (with its thought signature) is replayed unchanged in the next request.
        expect(requests[1].contents[1]).toEqual({
            role: "model",
            parts: [
                { text: "Start by locating the order." },
                {
                    functionCall: { id: "c1", name: "lookup_order", args: { orderId: order.orderId } },
                    thoughtSignature: "sig-lookup_order-0",
                },
            ],
        });

        // Parallel calls get one functionResponse each, in order, with matching id and name, plus agent state.
        const third = responsesIn(requests[3]);
        expect(third.map((r) => [r.id, r.name])).toEqual([
            ["c3", "extract_frames"],
            ["c4", "extract_frames"],
        ]);
        expect(third[1].response.agentState).toMatchObject({
            workflowState: "FRAME_EXTRACTION",
            evidence: { outboundFramesExtracted: true, returnFramesExtracted: true },
        });
        expect(JSON.stringify(requests)).not.toMatch(/Vu Thi F|0977 123 456|Ly Thuong Kiet/);
    });

    it("follows a different path when the evidence differs: it escalates instead of continuing", async () => {
        const { order, inspection } = await setup({ withReturn: false });
        const { client, requests } = scriptedGemini([
            turn(null, { id: "a", name: "lookup_order", args: { orderId: order.orderId } }),
            turn(null, { id: "b", name: "validate_evidence" }),
            // Gemini reads the validation result (EVIDENCE_MISSING) and decides to hand over.
            turn("The return video is missing, so no comparison is possible.", {
                id: "c",
                name: "notify_human",
                args: { reason: "Return opening video is missing" },
            }),
            final("Escalated: the return video must be uploaded before inspection."),
        ]);
        const result = await runInspection(inspection.id, { planner: new GeminiPlanner(client) });

        const validation = responsesIn(requests[2])[0].response;
        expect(validation.output.blocking).toBe(true);
        expect(validation.agentState.pendingEscalation).toContain("EVIDENCE_MISSING");
        expect(result.status).toBe("needs_review");
        expect(result.reviewTask?.reasons?.join(" ")).toMatch(/Agent note: Return opening video is missing/);
        expect(result.plannerFallback).toBe(false);
    });

    it("feeds invalid arguments and unknown tools back as errors so the model can correct itself", async () => {
        const { order, inspection } = await setup();
        const { client, requests } = scriptedGemini([
            turn(null, { name: "lookup_order", args: { order: 42 } }),
            turn(null, { name: "" }),
            turn(null, { name: "lookup_order", args: { orderId: order.orderId } }),
            final("Stopping here."),
        ]);
        const result = await runInspection(inspection.id, { planner: new GeminiPlanner(client) });

        const invalid = responsesIn(requests[1])[0];
        expect(invalid.id).toBeUndefined(); // Gemini gave no id, so none is invented in the response
        expect(invalid.name).toBe("lookup_order");
        expect(invalid.response.error.code).toBe("INVALID_ARGUMENTS");
        expect(responsesIn(requests[2])[0].response.error.code).toBe("UNKNOWN_TOOL");
        // The model stopped early: backend guardrails escalate instead of reporting success.
        expect(result.status).toBe("needs_review");
        expect(result.escalation?.reasons).toContain("WORKFLOW_ERROR");
    });

    it("cannot skip verification: an out-of-order claim request is rejected by the registry", async () => {
        const { inspection } = await setup({ scenario: "mismatch" });
        const { client, requests } = scriptedGemini([
            turn(null, { name: "build_claim_pack" }),
            final("Claim submitted."),
        ]);
        const result = await runInspection(inspection.id, { planner: new GeminiPlanner(client) });
        expect(responsesIn(requests[1])[0].response.error.code).toBe("TOOL_NOT_PERMITTED");
        expect(result.claimId).toBeUndefined();
        expect(result.status).toBe("needs_review");
    });
});

describe("GeminiPlanner failures fall back safely and visibly", () => {
    it("falls back to the deterministic planner on timeout and records it", async () => {
        const { inspection } = await setup({ scenario: "missing_item" });
        const { client } = scriptedGemini([
            () => {
                throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
            },
        ]);
        const result = await runInspection(inspection.id, { planner: new GeminiPlanner(client) });
        expect(result.plannerFallback).toBe(true);
        expect(
            result.agentLog.some((l) => l.kind === "guardrail" && /deterministic planner/.test(l.message ?? "")),
        ).toBe(true);
        expect(result.status).toBe("completed");
    });

    it("falls back when Gemini returns an empty or blocked turn", async () => {
        for (const bad of [
            { candidates: [{ content: { role: "model", parts: [] }, finishReason: FinishReason.STOP }] },
            { candidates: [{ finishReason: FinishReason.SAFETY }] },
            { candidates: [] },
        ]) {
            const { inspection } = await setup();
            const { client } = scriptedGemini([bad]);
            const result = await runInspection(inspection.id, { planner: new GeminiPlanner(client) });
            expect(result.plannerFallback).toBe(true);
            expect(result.status).toBe("completed");
        }
    });
});

describe("decision trace and provenance", () => {
    it("logs planner=gemini, the selected tool, its rationale and the tool result for every decision", async () => {
        const { order, inspection } = await setup({ withReturn: false });
        await Inspection.updateOne({ _id: inspection._id }, { $set: { analysisMode: "real" } });
        const { client } = scriptedGemini([
            turn("Locate the order first.", { name: "lookup_order", args: { orderId: order.orderId } }),
            turn("Confirm both videos exist.", { name: "validate_evidence" }),
            turn("Evidence is incomplete, hand over.", {
                name: "notify_human",
                args: { reason: "Return video missing" },
            }),
            final("Escalated."),
        ]);
        const result = await runInspection(inspection.id, { planner: new GeminiPlanner(client) });

        const decisions = result.agentLog.filter((l) => l.kind === "planner");
        expect(decisions.map((d) => [d.planner, d.selectedTools, d.rationale, d.fallbackUsed])).toEqual([
            ["gemini", ["lookup_order"], "Locate the order first.", false],
            ["gemini", ["validate_evidence"], "Confirm both videos exist.", false],
            ["gemini", ["notify_human"], "Evidence is incomplete, hand over.", false],
            ["gemini", undefined, "Escalated.", false],
        ]);
        const toolCalls = result.agentLog.filter((l) => l.kind === "tool_call");
        expect(toolCalls.map((t) => [t.planner, t.tool])).toEqual([
            ["gemini", "lookup_order"],
            ["gemini", "validate_evidence"],
            ["gemini", "notify_human"],
        ]);
        expect(toolCalls[1].result).toMatchObject({ blocking: true });

        const review = result.agentLog.find((l) => l.message === "HUMAN_REVIEW");
        expect(review?.reason).toMatch(/Missing return opening video/);
        expect(result).toMatchObject({ plannerUsed: "gemini", plannerFallback: false, executionLabel: "REAL_GEMINI" });
    });

    it("labels every post-fallback decision as deterministic and records why", async () => {
        const { inspection } = await setup();
        await Inspection.updateOne({ _id: inspection._id }, { $set: { analysisMode: "real" } });
        const { client } = scriptedGemini([
            () => {
                throw Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" });
            },
        ]);
        const result = await runInspection(inspection.id, { planner: new GeminiPlanner(client) });

        const failure = result.agentLog.find((l) => l.kind === "error");
        expect(failure).toMatchObject({ planner: "gemini", reason: expect.stringMatching(/timed out/) });
        const switchEntry = result.agentLog.find((l) => l.kind === "guardrail" && l.fallbackUsed);
        expect(switchEntry).toMatchObject({ planner: "deterministic", reason: expect.stringMatching(/timed out/) });

        const after = result.agentLog.filter((l) => l.kind === "planner" || l.kind === "tool_call");
        expect(after.length).toBeGreaterThan(0);
        expect(after.every((l) => l.planner === "deterministic")).toBe(true);
        expect(after.filter((l) => l.kind === "planner").every((l) => l.fallbackUsed === true)).toBe(true);
        expect(result).toMatchObject({
            plannerUsed: "deterministic",
            plannerFallback: true,
            executionLabel: "DETERMINISTIC_FALLBACK",
        });
    });

    it("selects the Gemini planner automatically when the inspection uses the LLM planner", async () => {
        const saved = { activeProvider: env.activeProvider, GEMINI_API_KEY: env.GEMINI_API_KEY };
        overrideEnv({ activeProvider: "gemini", GEMINI_API_KEY: undefined });
        try {
            const { inspection } = await setup();
            const result = await runInspection(inspection.id); // no injected planner
            // Without a key the Gemini planner fails before any network call; the trace shows it was chosen.
            const failure = result.agentLog.find((l) => l.kind === "error");
            expect(failure).toMatchObject({ planner: "gemini", reason: expect.stringMatching(/GEMINI_API_KEY/) });
            expect(result.plannerFallback).toBe(true);
        } finally {
            overrideEnv(saved);
        }
    });
});
