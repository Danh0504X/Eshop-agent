import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setTraceSink } from "../src/agent/agentTrace";
import { runInspection } from "../src/agent/fixitAgent";
import { DeterministicPlanner } from "../src/agent/planners/deterministicPlanner";
import { env, overrideEnv } from "../src/config/env";
import { Inspection } from "../src/models/Inspection";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { Order, type OrderDoc } from "../src/models/Order";
import { setVisionProvider } from "../src/services/vision";
import { DemoVisionProvider } from "../src/services/vision/demoVisionProvider";
import { aiError } from "../src/services/vision/errors";
import type { VisionProvider, VisionRequest } from "../src/services/vision/types";
import { selectFrames } from "../src/services/visionService";
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
const defaults = { AI_ANALYSIS_CACHE: env.AI_ANALYSIS_CACHE, GEMINI_THINKING_LEVEL: env.GEMINI_THINKING_LEVEL };

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
});
afterAll(disconnectTestDb);
afterEach(() => {
    setVisionProvider(undefined);
    setTraceSink(undefined);
    overrideEnv(defaults);
});

/** A provider reporting as real AI, answering from the demo data, that records its calls. */
const aiProvider = (options: { confidence?: number; delayMs?: number; failOnce?: "outbound" | "return" } = {}) => {
    const demo = new DemoVisionProvider();
    let failed = false;
    const provider: VisionProvider & { calls: VisionRequest[]; active: number; maxActive: number } = {
        source: "ai",
        calls: [],
        active: 0,
        maxActive: 0,
        analyze: async (request) => {
            provider.calls.push(request);
            provider.active++;
            provider.maxActive = Math.max(provider.maxActive, provider.active);
            await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5));
            provider.active--;
            if (options.failOnce === request.evidenceType && !failed) {
                failed = true;
                throw aiError("Vision model request timed out", true);
            }
            const response = await demo.analyze(request);
            return { ...response, analysis: { ...response.analysis, overallConfidence: options.confidence ?? 0.9 } };
        },
    };
    setVisionProvider(provider);
    return provider;
};

let seq = 0;
const newOrder = async () => {
    seq++;
    const order = await createOrder({ orderId: `ORD-SP-${seq}`, trackingCode: `TRK-SP-${seq}` });
    await createMediaFromFile(order, "outbound", await makeVideo("normal"), owner.principal.userId);
    await createMediaFromFile(order, "return", await makeVideo("normal"), owner.principal.userId);
    return order;
};

const inspect = async (order: OrderDoc) => {
    const inspection = await Inspection.create({
        orderId: order.orderId,
        orderRef: order._id,
        shopId: order.shopId,
        warehouseId: order.warehouseId,
        task: `Inspect ${order.orderId}`,
        analysisMode: "real",
        planner: "deterministic",
        requestedBy: owner.principal.userId,
    });
    return runInspection(inspection.id, { planner: new DeterministicPlanner() });
};

const frame = (id: number, quality: string) =>
    ({ frameId: `F-${id}`, index: id, timestampSec: id, quality }) as Parameters<typeof selectFrames>[0][number];

describe("selectFrames", () => {
    it("leaves out dark and blurry frames", () => {
        const frames = [frame(1, "ok"), frame(2, "dark"), frame(3, "ok"), frame(4, "blurry"), frame(5, "ok")];
        expect(selectFrames(frames, 8).map((f) => f.frameId)).toEqual(["F-1", "F-3", "F-5"]);
    });

    it("keeps every frame when too few are clear", () => {
        const frames = [frame(1, "ok"), frame(2, "dark"), frame(3, "blurry"), frame(4, "dark_and_blurry")];
        expect(selectFrames(frames, 8)).toHaveLength(4);
    });

    it("spreads the selection over the clear frames when there are more than the limit", () => {
        const frames = Array.from({ length: 12 }, (_, i) => frame(i, "ok"));
        expect(selectFrames(frames, 4).map((f) => f.frameId)).toEqual(["F-0", "F-3", "F-6", "F-9"]);
    });
});

describe("analyze_item speed", () => {
    it("analyses both videos at the same time and keeps the workflow order", async () => {
        const provider = aiProvider({ delayMs: 100 });
        const lines: string[] = [];
        setTraceSink((line) => lines.push(line));
        const result = await inspect(await newOrder());

        expect(result.status).toBe("completed");
        expect(provider.calls.map((c) => c.evidenceType).sort()).toEqual(["outbound", "return"]);
        expect(provider.maxActive).toBe(2);
        expect(result.budgetUsage).toMatchObject({ aiRequests: 2, framesAnalyzed: 16 });

        const tools = result.agentLog.filter((l) => l.tool === "analyze_item").map((l) => JSON.stringify(l.args));
        expect(tools).toEqual(['{"evidenceType":"outbound"}', '{"evidenceType":"return"}']);
        expect(lines.join("\n")).toMatch(/analysing the return video at the same time/);
        expect(lines.join("\n")).toMatch(/frames sent: 8 of 8 extracted/);
    });

    it("reuses the analyses of unchanged videos on the next run, and says so in the trace", async () => {
        const provider = aiProvider();
        const order = await newOrder();
        await inspect(order);
        expect(provider.calls).toHaveLength(2);

        const lines: string[] = [];
        setTraceSink((line) => lines.push(line));
        const second = await inspect(order);
        expect(second.status).toBe("completed");
        expect(provider.calls).toHaveLength(2);
        expect(second.outboundAnalysis).toMatchObject({ reused: true });
        expect(second.budgetUsage?.aiRequests ?? 0).toBe(0);
        expect(lines.join("\n")).toMatch(/REUSED from an earlier run, no AI call/);
    });

    it.each(["outbound", "return"] as const)("retries only the %s video when its request fails", async (failOnce) => {
        const provider = aiProvider({ failOnce });
        const result = await inspect(await newOrder());
        expect(result.status).toBe("completed");
        const count = (type: string) => provider.calls.filter((c) => c.evidenceType === type).length;
        expect(count(failOnce)).toBe(2);
        expect(count(failOnce === "outbound" ? "return" : "outbound")).toBe(1);
    });

    it("does not reuse an AI analysis when the provider changes", async () => {
        aiProvider();
        const order = await newOrder();
        await inspect(order);
        setVisionProvider(new DemoVisionProvider());
        const second = await inspect(order);
        expect(second.outboundAnalysis).toMatchObject({ source: "demo" });
        expect(second.outboundAnalysis?.reused).toBeUndefined();
    });

    it("analyses only the replaced video when the other one is unchanged", async () => {
        const provider = aiProvider();
        const order = await newOrder();
        await inspect(order);
        await createMediaFromFile(order, "return", await makeVideo("long"), owner.principal.userId);
        provider.calls.length = 0;
        await inspect((await Order.findById(order._id))!);
        expect(provider.calls.map((c) => c.evidenceType)).toEqual(["return"]);
    });

    it("analyses again when the checklist or the thinking level changes", async () => {
        const provider = aiProvider();
        const order = await newOrder();
        await inspect(order);

        await Order.updateOne({ _id: order._id }, { $set: { expectedAccessories: ["carry pouch"] } });
        await inspect((await Order.findById(order._id))!);
        expect(provider.calls).toHaveLength(4);

        overrideEnv({ GEMINI_THINKING_LEVEL: "HIGH" });
        await inspect((await Order.findById(order._id))!);
        expect(provider.calls).toHaveLength(6);
    });

    it("does not keep a low-confidence analysis, so running again is a real second attempt", async () => {
        const provider = aiProvider({ confidence: 0.4 });
        const order = await newOrder();
        expect((await inspect(order)).status).toBe("needs_review");
        await inspect(order);
        expect(provider.calls).toHaveLength(4);
    });

    it("can be turned off, and stays out of the media API output", async () => {
        const provider = aiProvider();
        const order = await newOrder();
        overrideEnv({ AI_ANALYSIS_CACHE: false });
        await inspect(order);
        await inspect(order);
        expect(provider.calls).toHaveLength(4);

        const { serializeMedia } = await import("../src/services/mediaService");
        const media = (await MediaEvidence.findOne({ orderId: order.orderId }))!;
        expect(media.analysisCache?.key).toBeTypeOf("string");
        expect(serializeMedia(media)).not.toHaveProperty("analysisCache");
    });
});
