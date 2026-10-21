import { FinishReason } from "@google/genai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createContext, type AgentContext } from "../src/agent/agentState";
import { runInspection } from "../src/agent/fixitAgent";
import { GeminiPlanner } from "../src/agent/planners/geminiPlanner";
import { executeTool } from "../src/agent/toolRegistry";
import { env, overrideEnv } from "../src/config/env";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import { MediaEvidence } from "../src/models/MediaEvidence";
import type { GeminiModelsClient } from "../src/services/ai/gemini";
import { storage } from "../src/services/storageService";
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
    MAX_SEGMENT_INSPECTIONS: env.MAX_SEGMENT_INSPECTIONS,
    MAX_REANALYSES_PER_VIDEO: env.MAX_REANALYSES_PER_VIDEO,
    MAX_AI_REQUESTS_PER_INSPECTION: env.MAX_AI_REQUESTS_PER_INSPECTION,
    MAX_TOTAL_FRAMES_ANALYZED: env.MAX_TOTAL_FRAMES_ANALYZED,
};

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
});
afterAll(disconnectTestDb);
afterEach(() => {
    overrideEnv(defaults);
    setVisionProvider(undefined);
});

const QUESTION = "Is the front casing cracked or otherwise damaged?";

let seq = 0;
const setup = async (scenario = "needs_closer_look") => {
    seq++;
    const order = await createOrder({
        orderId: `ORD-AL-${seq}`,
        trackingCode: `TRK-AL-${seq}`,
        demoScenario: scenario,
        product: { name: "Smart Watch", model: "SW-200", color: "silver" },
    });
    await createMediaFromFile(order, "outbound", await makeVideo("normal"), owner.principal.userId);
    await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
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

/** Context positioned after the standard first pass (lookup → validate → extract ×2 → analyze ×2 → compare). */
const afterFirstPass = async (scenario?: string): Promise<AgentContext> => {
    const { order, inspection } = await setup(scenario);
    const ctx = createContext(inspection, owner.principal);
    ctx.plannerName = "gemini";
    for (const [name, args] of [
        ["lookup_order", { orderId: order.orderId }],
        ["validate_evidence", {}],
        ["extract_frames", { evidenceType: "outbound" }],
        ["extract_frames", { evidenceType: "return" }],
        ["analyze_item", { evidenceType: "outbound" }],
        ["analyze_item", { evidenceType: "return" }],
        ["compare_items", {}],
    ] as const) {
        const result = await executeTool(ctx, name, args);
        expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
    }
    return ctx;
};

const inspect = (ctx: AgentContext, startSeconds: number, endSeconds: number, question = QUESTION, frameCount = 4) =>
    executeTool(ctx, "inspect_video_segment", {
        evidenceType: "return",
        startSeconds,
        endSeconds,
        question,
        frameCount,
    });

// --- Scripted Gemini planner -------------------------------------------------------------------------------------

type Call = { name: string; args?: Record<string, unknown> };
const turn = (text: string, ...calls: Call[]) => ({
    candidates: [
        {
            content: {
                role: "model",
                parts: [{ text }, ...calls.map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } }))],
            },
            finishReason: FinishReason.STOP,
        },
    ],
});
const final = (text: string) => ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: FinishReason.STOP }],
});
const scripted = (script: unknown[]) => {
    const requests: Array<{ contents: Array<{ parts: Array<Record<string, any>> }> }> = [];
    const generateContent = vi.fn(async (params: unknown) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        const next = script.shift();
        if (!next) throw new Error("script exhausted");
        return next;
    });
    return { planner: new GeminiPlanner({ models: { generateContent } } as unknown as GeminiModelsClient), requests };
};
const lastResponse = (requests: Array<{ contents: Array<{ parts: Array<Record<string, any>> }> }>, i: number) =>
    requests[i].contents.at(-1)!.parts[0].functionResponse.response;

// --- Tests -------------------------------------------------------------------------------------------------------

describe("adaptive re-inspection loop (Gemini planner, demo vision)", () => {
    it("re-inspects an unclear area, re-analyses with the new frames, re-verifies and drafts a grounded claim", async () => {
        overrideEnv({ MAX_AI_REQUESTS_PER_INSPECTION: 40 });
        const { order, inspection } = await setup();
        const { planner, requests } = scripted([
            turn("Find the order.", { name: "lookup_order", args: { orderId: order.orderId } }),
            turn("Check the evidence exists.", { name: "validate_evidence" }),
            turn(
                "Extract frames.",
                { name: "extract_frames", args: { evidenceType: "outbound" } },
                { name: "extract_frames", args: { evidenceType: "return" } },
            ),
            turn(
                "Analyse both videos.",
                { name: "analyze_item", args: { evidenceType: "outbound" } },
                { name: "analyze_item", args: { evidenceType: "return" } },
            ),
            turn("Compare.", { name: "compare_items" }),
            turn("The casing condition is not verifiable; look closer at 1-3 s of the return video.", {
                name: "inspect_video_segment",
                args: { evidenceType: "return", startSeconds: 1, endSeconds: 3, question: QUESTION, frameCount: 4 },
            }),
            turn("A crack was confirmed; re-analyse the return video with those frames.", {
                name: "analyze_item",
                args: { evidenceType: "return", includeSegmentFrames: true },
            }),
            turn("Compare again with the updated analysis.", { name: "compare_items" }),
            turn("Verify before any claim.", { name: "validate_evidence" }),
            turn("A material, verified difference: draft the claim.", { name: "build_claim_pack" }),
            final(
                "A hairline crack (RET-S1-02, RET-S1-03) is visible in the return but not when packed. Draft claim awaits review.",
            ),
        ]);
        const result = await runInspection(inspection.id, { planner });

        // Gemini saw the segment answer and its remaining budget before deciding to re-analyse.
        const segmentResponse = lastResponse(requests, 6);
        expect(segmentResponse.output).toMatchObject({ segmentId: "S1", verdict: "confirmed" });
        expect(segmentResponse.agentState.workflowState).toBe("ADDITIONAL_INSPECTION");
        expect(segmentResponse.agentState.budgetRemaining.segmentInspections).toBe(env.MAX_SEGMENT_INSPECTIONS - 1);

        expect(result.status).toBe("completed");
        const claim = await Claim.findOne({ inspectionId: inspection._id });
        const finding = claim?.findings.find((f: { category: string }) => f.category === "product_condition_change");
        expect(finding).toMatchObject({ severity: "high", certainty: "observed" });
        expect(finding.evidence.map((e: { frameId: string }) => e.frameId)).toEqual(
            expect.arrayContaining(["RET-S1-02", "RET-S1-03"]),
        );
        expect(finding.description).toMatch(/cannot show when or how/);

        // The replaced analysis is kept, and every frame either analysis cites still exists.
        const saved = (await Inspection.findById(inspection._id))!;
        expect(saved.analysisHistory).toHaveLength(1);
        expect(saved.analysisHistory[0].result.items[0].condition.status).toBe("uncertain");
        expect(saved.segmentInspections[0]).toMatchObject({
            segmentId: "S1",
            question: QUESTION,
            result: { verdict: "confirmed" },
        });
        const media = (await MediaEvidence.findById(saved.returnAnalysis.mediaId))!;
        const keys = new Map(media.frames.map((f) => [f.frameId, f.storageKey]));
        for (const record of [saved.analysisHistory[0], saved.returnAnalysis]) {
            for (const f of record.framesAnalyzed) expect(await storage().exists(keys.get(f.frameId)!)).toBe(true);
        }
        expect(saved.stateHistory.map((s) => s.state)).toEqual(
            expect.arrayContaining(["ADDITIONAL_INSPECTION", "COMPARISON", "VERIFICATION", "CLAIM_DRAFT"]),
        );
        // 11 planner turns + 2 analyses + 1 segment inspection + 1 re-analysis.
        expect(saved.budgetUsage).toMatchObject({
            aiRequests: 15,
            segmentInspections: 1,
            reanalyses: { return: 1, outbound: 0 },
        });
    });

    it("cannot draft a claim from new evidence until it has been compared and verified again", async () => {
        overrideEnv({ MAX_AI_REQUESTS_PER_INSPECTION: 40 });
        const { order, inspection } = await setup("mismatch");
        const { planner, requests } = scripted([
            turn("", { name: "lookup_order", args: { orderId: order.orderId } }),
            turn("", { name: "validate_evidence" }),
            turn(
                "",
                { name: "extract_frames", args: { evidenceType: "outbound" } },
                { name: "extract_frames", args: { evidenceType: "return" } },
            ),
            turn(
                "",
                { name: "analyze_item", args: { evidenceType: "outbound" } },
                { name: "analyze_item", args: { evidenceType: "return" } },
            ),
            turn("", { name: "compare_items" }),
            turn("", { name: "validate_evidence" }),
            turn("Double-check the colour before claiming.", {
                name: "inspect_video_segment",
                args: {
                    evidenceType: "return",
                    startSeconds: 2,
                    endSeconds: 3,
                    question: "What colour is the watch casing?",
                    frameCount: 2,
                },
            }),
            turn("Draft the claim now.", { name: "build_claim_pack" }),
            final("Done."),
        ]);
        const result = await runInspection(inspection.id, { planner });
        expect(lastResponse(requests, 8).error.code).toBe("TOOL_NOT_PERMITTED");
        expect(result.claimId).toBeUndefined();
        expect(result.status).toBe("needs_review");
        expect(result.escalation?.reasons).toContain("WORKFLOW_ERROR");
    });

    it("stops the planner when the AI request budget is used up and hands over to a human", async () => {
        overrideEnv({ MAX_AI_REQUESTS_PER_INSPECTION: 3 });
        const { order, inspection } = await setup();
        const { planner } = scripted([
            turn("", { name: "lookup_order", args: { orderId: order.orderId } }),
            turn("", { name: "validate_evidence" }),
            turn("", { name: "extract_frames", args: { evidenceType: "outbound" } }),
            turn("", { name: "extract_frames", args: { evidenceType: "return" } }),
        ]);
        const result = await runInspection(inspection.id, { planner });
        expect(result.agentLog.some((l) => /AI request budget of 3 used up/.test(l.message ?? ""))).toBe(true);
        expect(result.budgetUsage).toMatchObject({ aiRequests: 3 });
        expect(result.status).toBe("needs_review");
    });
});

describe("re-inspection guards", () => {
    it("rejects a repeated segment, but a different segment is a new inspection, not a retry", async () => {
        const ctx = await afterFirstPass();
        expect((await inspect(ctx, 1, 3)).ok).toBe(true);
        expect(await inspect(ctx, 1, 3)).toMatchObject({
            ok: false,
            error: { code: "DUPLICATE_SEGMENT", retryable: false },
        });
        expect(await inspect(ctx, 1.1, 3)).toMatchObject({ ok: false, error: { code: "DUPLICATE_SEGMENT" } });
        const different = await inspect(ctx, 1.1, 3, "Is the charging port area visible and intact?");
        expect(different).toMatchObject({ ok: true, data: { segmentId: "S2" } });
        expect(ctx.attempts["inspect_video_segment:return:1-3"]).toBe(2);
        expect(ctx.attempts["inspect_video_segment:return:1.1-3"]).toBe(2);
    });

    it("enforces the segment and re-analysis budgets", async () => {
        overrideEnv({ MAX_SEGMENT_INSPECTIONS: 2, MAX_REANALYSES_PER_VIDEO: 1 });
        const ctx = await afterFirstPass();
        expect((await inspect(ctx, 0.5, 1.5)).ok).toBe(true);
        expect(
            (await executeTool(ctx, "analyze_item", { evidenceType: "return", includeSegmentFrames: true })).ok,
        ).toBe(true);
        expect((await executeTool(ctx, "compare_items", {})).ok).toBe(true);
        expect((await inspect(ctx, 2, 3)).ok).toBe(true);
        expect(
            await executeTool(ctx, "analyze_item", { evidenceType: "return", includeSegmentFrames: true }),
        ).toMatchObject({
            ok: false,
            error: { code: "BUDGET_EXHAUSTED", retryable: false },
        });
        expect(await inspect(ctx, 3, 3.9)).toMatchObject({ ok: false, error: { code: "BUDGET_EXHAUSTED" } });
        expect((await Inspection.findById(ctx.inspection._id))?.budgetUsage).toMatchObject({
            segmentInspections: 2,
            reanalyses: { return: 1 },
        });
    });

    it("allows re-analysis only with new segment frames inside the re-inspection state", async () => {
        const ctx = await afterFirstPass();
        // Not in ADDITIONAL_INSPECTION yet: the analysis is not re-run.
        expect(
            await executeTool(ctx, "analyze_item", { evidenceType: "return", includeSegmentFrames: true }),
        ).toMatchObject({
            ok: false,
            error: { code: "TOOL_NOT_PERMITTED" },
        });
        await inspect(ctx, 1, 3);
        expect(await executeTool(ctx, "analyze_item", { evidenceType: "return" })).toMatchObject({
            ok: false,
            error: { code: "INVALID_STATE", message: expect.stringMatching(/includeSegmentFrames=true/) },
        });
        expect(
            await executeTool(ctx, "analyze_item", { evidenceType: "outbound", includeSegmentFrames: true }),
        ).toMatchObject({
            ok: false,
            error: { code: "INVALID_STATE", message: expect.stringMatching(/No new segment frames of the outbound/) },
        });
        const reanalysis = await executeTool(ctx, "analyze_item", {
            evidenceType: "return",
            includeSegmentFrames: true,
        });
        expect(reanalysis).toMatchObject({ ok: true, data: { reanalysis: true } });
    });

    it("keeps baseline frames intact and invalidates the earlier verification after new evidence", async () => {
        const ctx = await afterFirstPass();
        expect((await executeTool(ctx, "validate_evidence", {})).ok).toBe(true);
        expect(ctx.finalValidation).toBeDefined();
        const before = (await MediaEvidence.findById(ctx.analyses.return!.mediaId))!.frames.map((f) => [
            f.frameId,
            f.storageKey,
        ]);

        await inspect(ctx, 1, 3);
        expect(ctx.finalValidation).toBeUndefined();
        expect(ctx.state).toBe("ADDITIONAL_INSPECTION");
        const after = (await MediaEvidence.findById(ctx.analyses.return!.mediaId))!.frames;
        expect(after.slice(0, before.length).map((f) => [f.frameId, f.storageKey])).toEqual(before);
        expect(after.filter((f) => f.origin === "segment")).toHaveLength(4);
    });
});
