import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AgentContext } from "../src/agent/agentState";
import { executeTool, plannerToolDefinitions } from "../src/agent/toolRegistry";
import { env, overrideEnv } from "../src/config/env";
import { AuditLog } from "../src/models/AuditLog";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import { setVisionProvider } from "../src/services/vision";
import { aiError } from "../src/services/vision/anthropicVisionProvider";
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
    AGENT_TOOL_TIMEOUT_MS: env.AGENT_TOOL_TIMEOUT_MS,
    AGENT_MAX_TOOL_RETRIES: env.AGENT_MAX_TOOL_RETRIES,
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
const newContext = async (opts: { scenario?: string; withReturn?: boolean } = {}) => {
    seq++;
    const order = await createOrder({
        orderId: `ORD-TOOL-${seq}`,
        trackingCode: `TRK-TOOL-${seq}`,
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
        task: `Inspect the returned package for order ${order.orderId}`,
        analysisMode: "demo",
        planner: "deterministic",
    });
    return { ctx: createContext(inspection, owner.principal), order };
};

const run = async (ctx: AgentContext, name: string, args: unknown = {}) => executeTool(ctx, name, args);

describe("tool registry guards", () => {
    it("exposes the planner tools with object schemas", () => {
        const defs = plannerToolDefinitions();
        expect(defs).toHaveLength(10);
        for (const d of defs) expect(d.input_schema.type).toBe("object");
    });

    it("rejects unknown tools, invalid arguments and out-of-order calls", async () => {
        const { ctx } = await newContext();
        expect(await run(ctx, "delete_everything")).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
        expect(await run(ctx, "analyze_item", { evidenceType: "return" })).toMatchObject({
            ok: false,
            error: { code: "TOOL_NOT_PERMITTED" },
        });
        expect(await run(ctx, "lookup_order", {})).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
        expect(await run(ctx, "lookup_order", { orderId: "x", shell: "rm -rf /" })).toMatchObject({
            ok: false,
            error: { code: "INVALID_ARGUMENTS" },
        });
        expect(ctx.state).toBe("RECEIVED");
    });

    it("refuses to look up a different order than the one under inspection", async () => {
        const { ctx } = await newContext();
        const other = await newContext();
        const result = await run(ctx, "lookup_order", { orderId: other.order.orderId });
        expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR", retryable: false } });
    });
});

describe("tool workflow", () => {
    it("runs every step, persists state transitions, and drafts a claim for a mismatch", async () => {
        setVisionProvider(new DemoVisionProvider());
        const { ctx, order } = await newContext({ scenario: "mismatch" });

        expect((await run(ctx, "lookup_order", { orderId: order.orderId })).ok).toBe(true);
        const lookup = ctx.inspection.agentLog.at(-1)?.result as Record<string, unknown>;
        expect(lookup).not.toHaveProperty("customer");
        expect(await run(ctx, "validate_evidence")).toMatchObject({ ok: true, data: { blocking: false } });
        expect((await run(ctx, "extract_frames", { evidenceType: "outbound" })).ok).toBe(true);
        expect(await run(ctx, "extract_frames", { evidenceType: "return" })).toMatchObject({
            ok: true,
            data: { bothExtracted: true, nextStep: "analyze_item" },
        });
        expect((await run(ctx, "analyze_item", { evidenceType: "outbound" })).ok).toBe(true);
        expect((await run(ctx, "analyze_item", { evidenceType: "return" })).ok).toBe(true);
        expect(await run(ctx, "compare_items")).toMatchObject({ ok: true, data: { materialDiscrepancyCount: 1 } });
        expect(await run(ctx, "verify_product_match")).toMatchObject({
            ok: true,
            data: { materialDiscrepancyCount: 2 },
        });
        expect(await run(ctx, "validate_evidence")).toMatchObject({
            ok: true,
            data: { stage: "final", blocking: false },
        });
        const claim = await run(ctx, "build_claim_pack");
        expect(claim).toMatchObject({ ok: true, data: { status: "pending_approval" } });

        const saved = await Inspection.findById(ctx.inspection._id);
        expect(saved?.stateHistory.map((s) => s.state)).toEqual([
            "ORDER_LOOKUP",
            "EVIDENCE_VALIDATION",
            "FRAME_EXTRACTION",
            "ITEM_ANALYSIS",
            "COMPARISON",
            "VERIFICATION",
            "CLAIM_DRAFT",
        ]);
        expect(saved?.outboundAnalysis.source).toBe("demo");
        expect(saved?.comparison.findings.length).toBeGreaterThan(0);
        expect(saved?.frameReferences.length).toBeGreaterThan(0);
        expect(saved?.agentLog.filter((l) => l.kind === "tool_call")).toHaveLength(10);
        expect(await Claim.countDocuments({ inspectionId: ctx.inspection._id })).toBe(1);
        expect(
            await AuditLog.countDocuments({ inspectionId: ctx.inspection.id, actorType: "agent" }),
        ).toBeGreaterThanOrEqual(9);
    });

    it("blocks all tools except notify_human once blocking evidence issues are found", async () => {
        const { ctx, order } = await newContext({ withReturn: false });
        await run(ctx, "lookup_order", { orderId: order.orderId });
        expect(await run(ctx, "validate_evidence")).toMatchObject({
            ok: true,
            data: { blocking: true, nextStep: "notify_human" },
        });
        expect(await run(ctx, "extract_frames", { evidenceType: "outbound" })).toMatchObject({
            ok: false,
            error: { code: "ESCALATION_REQUIRED" },
        });
        expect((await run(ctx, "notify_human", { reason: "Return video missing" })).ok).toBe(true);

        const saved = await Inspection.findById(ctx.inspection._id);
        expect(saved?.workflowState).toBe("HUMAN_REVIEW");
        expect(saved?.reviewTask).toMatchObject({ status: "open" });
        expect(saved?.reviewTask?.requiredAction).toMatch(/Upload the missing evidence/);
        expect(saved?.escalation).toMatchObject({ required: true, blocking: true, reasons: ["EVIDENCE_MISSING"] });
    });

    it("counts retries per evidence type and stops at the retry limit", async () => {
        overrideEnv({ AGENT_MAX_TOOL_RETRIES: 1 });
        setVisionProvider({
            source: "ai",
            analyze: async () => {
                throw aiError("Vision model request timed out", true);
            },
        });
        const { ctx, order } = await newContext();
        await run(ctx, "lookup_order", { orderId: order.orderId });
        await run(ctx, "validate_evidence");
        await run(ctx, "extract_frames", { evidenceType: "outbound" });
        await run(ctx, "extract_frames", { evidenceType: "return" });

        expect(await run(ctx, "analyze_item", { evidenceType: "outbound" })).toMatchObject({
            ok: false,
            error: { code: "AI_ERROR", retryable: true },
        });
        expect((await run(ctx, "analyze_item", { evidenceType: "outbound" })).ok).toBe(false);
        expect(await run(ctx, "analyze_item", { evidenceType: "outbound" })).toMatchObject({
            ok: false,
            error: { code: "RETRY_LIMIT" },
        });
        // A different evidence type has its own budget.
        expect(await run(ctx, "analyze_item", { evidenceType: "return" })).toMatchObject({
            error: { code: "AI_ERROR" },
        });
    });

    it("times out a hanging tool", async () => {
        overrideEnv({ AGENT_TOOL_TIMEOUT_MS: 200 });
        setVisionProvider({ source: "ai", analyze: () => new Promise(() => {}) });
        const { ctx, order } = await newContext();
        await run(ctx, "lookup_order", { orderId: order.orderId });
        await run(ctx, "validate_evidence");
        overrideEnv({ AGENT_TOOL_TIMEOUT_MS: 60_000 });
        await run(ctx, "extract_frames", { evidenceType: "outbound" });
        await run(ctx, "extract_frames", { evidenceType: "return" });
        overrideEnv({ AGENT_TOOL_TIMEOUT_MS: 200 });
        expect(await run(ctx, "analyze_item", { evidenceType: "outbound" })).toMatchObject({
            ok: false,
            error: { code: "TIMEOUT", retryable: true },
        });
    });
});

describe("inspection time budget", () => {
    const readyForAnalysis = async () => {
        const { ctx, order } = await newContext();
        await run(ctx, "lookup_order", { orderId: order.orderId });
        await run(ctx, "validate_evidence");
        await run(ctx, "extract_frames", { evidenceType: "outbound" });
        await run(ctx, "extract_frames", { evidenceType: "return" });
        return ctx;
    };

    it("cuts a tool off at the inspection deadline even when its own timeout is longer", async () => {
        setVisionProvider({ source: "ai", analyze: () => new Promise(() => {}) });
        const ctx = await readyForAnalysis();
        ctx.deadline = Date.now() + 300; // tool timeout stays at the 5-minute default
        const started = Date.now();
        expect(await run(ctx, "analyze_item", { evidenceType: "outbound" })).toMatchObject({
            ok: false,
            error: { code: "TIMEOUT" },
        });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(ctx.toolDeadline).toBeUndefined();
    });

    it("does not start a tool once the budget is used up", async () => {
        let calls = 0;
        setVisionProvider({
            source: "ai",
            analyze: async () => {
                calls++;
                throw new Error("should not run");
            },
        });
        const ctx = await readyForAnalysis();
        ctx.deadline = Date.now() - 1;
        expect(await run(ctx, "analyze_item", { evidenceType: "outbound" })).toMatchObject({
            ok: false,
            error: { code: "TIMEOUT", message: expect.stringMatching(/budget exhausted/) },
        });
        expect(calls).toBe(0);
    });

    it("passes the tool deadline (bounded by the inspection deadline) to the vision provider", async () => {
        const seen: Array<number | undefined> = [];
        const demo = new DemoVisionProvider();
        setVisionProvider({
            source: "demo",
            analyze: (req) => {
                seen.push(req.deadlineMs);
                return demo.analyze(req);
            },
        });
        const ctx = await readyForAnalysis();
        ctx.deadline = Date.now() + 60_000;
        await run(ctx, "analyze_item", { evidenceType: "outbound" });
        expect(seen[0]).toBeDefined();
        expect(seen[0]!).toBeLessThanOrEqual(ctx.deadline);
        expect(seen[0]!).toBeGreaterThan(Date.now());
    });
});
