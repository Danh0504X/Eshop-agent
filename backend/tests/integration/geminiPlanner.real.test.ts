/**
 * OPT-IN integration test: the real Gemini planner drives an inspection through function calling.
 *
 *   PowerShell:  $env:GEMINI_INTEGRATION="1"; npm run test:gemini
 *
 * Scenario: the return video is missing, so no vision calls are made (a handful of planner calls only).
 * It verifies that Gemini chooses tools itself, reacts to the validation result, and that the backend
 * records the decision trace. It does not measure inspection accuracy.
 */
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInspection } from "../../src/agent/fixitAgent";
import { GeminiPlanner } from "../../src/agent/planners/geminiPlanner";
import { overrideEnv } from "../../src/config/env";
import { Inspection } from "../../src/models/Inspection";
import { setVisionProvider } from "../../src/services/vision";
import { DemoVisionProvider } from "../../src/services/vision/demoVisionProvider";
import { connectTestDb, createMediaFromFile, createOrder, createUser, disconnectTestDb, makeVideo } from "../helpers";

const enabled = process.env.GEMINI_INTEGRATION === "1" && Boolean(process.env.GEMINI_API_KEY);

describe.skipIf(!enabled)("Gemini planner (real API)", () => {
    beforeAll(async () => {
        await connectTestDb();
        overrideEnv({
            GEMINI_API_KEY: process.env.GEMINI_API_KEY,
            ...(process.env.GEMINI_PLANNER_MODEL ? { GEMINI_PLANNER_MODEL: process.env.GEMINI_PLANNER_MODEL } : {}),
        });
        // Guard: if Gemini unexpectedly reaches analysis, no real vision call is spent.
        setVisionProvider(new DemoVisionProvider());
    });
    afterAll(async () => {
        setVisionProvider(undefined);
        await disconnectTestDb();
    });

    it("chooses tools through function calling and reacts to missing evidence", async () => {
        const owner = await createUser({ role: "owner", shopId: "shop-real" });
        const order = await createOrder({ shopId: "shop-real", orderId: "ORD-REAL-1", trackingCode: "TRK-REAL-1" });
        await createMediaFromFile(
            order,
            "outbound",
            await makeVideo("normal"),
            new mongoose.Types.ObjectId().toString(),
        );
        const inspection = await Inspection.create({
            orderId: order.orderId,
            orderRef: order._id,
            shopId: order.shopId,
            warehouseId: order.warehouseId,
            task: `Inspect the returned package for order ${order.orderId}.`,
            analysisMode: "real",
            planner: "llm",
            requestedBy: owner.principal.userId,
        });

        const result = await runInspection(inspection.id, { planner: new GeminiPlanner() });

        const trace = result.agentLog
            .filter(
                (l) =>
                    l.kind === "planner" ||
                    l.kind === "tool_call" ||
                    l.kind === "error" ||
                    l.message === "HUMAN_REVIEW",
            )
            .map((l) =>
                l.kind === "planner"
                    ? `planner=${l.planner} selected=${(l.selectedTools ?? ["<finish>"]).join(",")} rationale="${l.rationale ?? ""}"`
                    : l.kind === "tool_call"
                      ? `  tool=${l.tool} by=${l.planner} ${l.error ? `error=${l.error}` : "ok"}`
                      : `${l.kind === "error" ? "ERROR" : "HUMAN_REVIEW"} reason=${l.reason ?? l.message}`,
            );
        console.info(`Decision trace:\n${trace.join("\n")}`);
        console.info(
            `status=${result.status} plannerUsed=${result.plannerUsed} fallback=${result.plannerFallback} label=${result.executionLabel}`,
        );

        const decisions = result.agentLog.filter((l) => l.kind === "planner");
        expect(result.plannerFallback).toBe(false);
        expect(result.plannerUsed).toBe("gemini");
        expect(decisions.length).toBeGreaterThanOrEqual(2);
        expect(decisions.every((d) => d.planner === "gemini")).toBe(true);
        expect(decisions[0].selectedTools).toEqual(["lookup_order"]);
        expect(result.status).toBe("needs_review");
        expect(result.executionLabel).toBe("REAL_GEMINI");
    }, 900_000);
});
