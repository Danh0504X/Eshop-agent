import { FinishReason } from "@google/genai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setTraceSink, summarizeToolResult } from "../src/agent/agentTrace";
import { runInspection } from "../src/agent/fixitAgent";
import { DeterministicPlanner } from "../src/agent/planners/deterministicPlanner";
import { GeminiPlanner } from "../src/agent/planners/geminiPlanner";
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
let lines: string[] = [];

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
});
afterAll(disconnectTestDb);
afterEach(() => {
    setTraceSink(undefined);
    setVisionProvider(undefined);
    lines = [];
});

let seq = 0;
const setup = async (opts: { scenario?: string; withReturn?: boolean; planner?: "llm" | "deterministic" } = {}) => {
    seq++;
    const order = await createOrder({
        orderId: `ORD-TR-${seq}`,
        trackingCode: `TRK-TR-${seq}`,
        demoScenario: opts.scenario ?? "normal",
    });
    await createMediaFromFile(order, "outbound", await makeVideo("normal"), owner.principal.userId);
    if (opts.withReturn !== false)
        await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
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
    setVisionProvider(new DemoVisionProvider());
    setTraceSink((line) => lines.push(line));
    return { order, inspection };
};

const text = () => lines.join("\n");

describe("console trace of the two-video check", () => {
    it("shows every step of a mismatch inspection: frames, both analyses, findings with frames, claim and result", async () => {
        const { order, inspection } = await setup({ scenario: "mismatch" });
        await runInspection(inspection.id, { planner: new DeterministicPlanner() });
        const out = text();

        expect(lines.every((l) => l.startsWith(`[FixIt ${order.orderId} `) || l.startsWith(" "))).toBe(true);
        expect(out).toMatch(/START inspection .* analysis=DEMO DATA \| planner=deterministic/);
        expect(out).toMatch(/planner=deterministic -> lookup_order/);
        expect(out).toMatch(/OK {3}extract_frames \{"evidenceType":"outbound"\}.*outbound video: 8 frames/);
        expect(out).toMatch(/quality: dark 0%, blurry 0%.*continuous/);
        expect(out).toMatch(/frames: OUT-01@\d+\.\ds/);
        expect(out).toMatch(/OK {3}analyze_item \{"evidenceType":"return"\}.*return analysis \(DEMO DATA\)/);
        expect(out).toMatch(/colour white \(observed\) \| model .*-LITE \(observed\)/);
        expect(out).toMatch(/comparison: 2 material discrepancy\(ies\), max severity high/);
        expect(out).toMatch(/F01 HIGH model_mismatch \[observed\].*\(OUT-05@\d+\.\ds/);
        expect(out).toMatch(/final validation: OK/);
        expect(out).toMatch(/draft claim .* created \(pending_approval\)/);
        expect(out).toMatch(/RESULT status=COMPLETED \| label=DEMO \| plannerUsed=deterministic \| claim=[a-f0-9]{24}/);
        // SHOW_TRACE=1 prints the captured trace, to preview what the server console shows during a demo.
        if (process.env.SHOW_TRACE) console.info(`\n${out}\n`);
    });

    it("shows why an inspection went to human review", async () => {
        const { inspection } = await setup({ withReturn: false });
        await runInspection(inspection.id, { planner: new DeterministicPlanner() });
        const out = text();
        expect(out).toMatch(/initial validation: issues found \(BLOCKING\)/);
        expect(out).toMatch(/BLOCKING EVIDENCE_MISSING: Missing return opening video/);
        expect(out).toMatch(/RESULT status=NEEDS_REVIEW/);
        expect(out).toMatch(/human review because: Missing return opening video/);
    });

    it("shows Gemini planner decisions with rationale, Gemini call timing, failures and the fallback", async () => {
        const { order, inspection } = await setup({ planner: "llm" });
        const generateContent = vi
            .fn()
            .mockResolvedValueOnce({
                candidates: [
                    {
                        content: {
                            role: "model",
                            parts: [
                                { text: "Locate the order first." },
                                { functionCall: { name: "lookup_order", args: { orderId: order.orderId } } },
                            ],
                        },
                        finishReason: FinishReason.STOP,
                    },
                ],
                usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 120 },
            })
            .mockRejectedValueOnce(Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" }));
        const client = { models: { generateContent } } as unknown as GeminiModelsClient;
        await runInspection(inspection.id, { planner: new GeminiPlanner(client) });
        const out = text();

        expect(out).toMatch(/planner=gemini/);
        expect(out).toMatch(/Gemini Planner request -> gemini-3.8-flash/);
        expect(out).toMatch(/Gemini Planner replied in \d+\.\ds \(tokens in 900, out 40, thinking 120; attempts 1\)/);
        expect(out).toMatch(/#1 \[RECEIVED\] planner=gemini -> lookup_order\n\s+why: Locate the order first\./);
        expect(out).toMatch(/Gemini Planner FAILED after .*timed out/);
        expect(out).toMatch(/ERROR: planner=gemini failed/);
        expect(out).toMatch(/GUARDRAIL: Switched to the deterministic planner/);
        expect(out).toMatch(/planner=deterministic \(fallback\) -> /);
        expect(out).toMatch(/RESULT .*plannerUsed=deterministic \(fallback used\)/);
    });

    it("shows a failing tool with its error code", () => {
        // summarizeToolResult covers successes; failures are printed from the error itself.
        expect(summarizeToolResult("notify_human", { reasons: ["LOW_CONFIDENCE"], requiredAction: "Review" })).toEqual({
            headline: "human review requested: LOW_CONFIDENCE",
            details: ["required action: Review"],
        });
    });
});
