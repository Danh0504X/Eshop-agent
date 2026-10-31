import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeAnalysis, type VisionAnalysis } from "../src/agent/schemas";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { setVisionProvider } from "../src/services/vision";
import { DemoVisionProvider } from "../src/services/vision/demoVisionProvider";
import { extractFrames } from "../src/services/videoProcessingService";
import { analyzeEvidence } from "../src/services/visionService";
import { connectTestDb, createMediaFromFile, createOrder, disconnectTestDb, makeVideo } from "./helpers";

const uploader = new mongoose.Types.ObjectId().toString();

const sampleAnalysis = (overrides: Partial<VisionAnalysis> = {}): VisionAnalysis => ({
    packageContents: "items_present",
    packageContentsFrameIds: ["RET-01"],
    items: [
        {
            description: "Black over-ear headphones",
            productType: { value: "headphones", status: "observed", frameIds: ["RET-01"] },
            quantity: { value: 1, status: "observed", frameIds: ["RET-01"] },
            color: { value: "black", status: "observed", frameIds: ["RET-01"] },
            model: { value: null, status: "not_visible", frameIds: [] },
            brand: { value: null, status: "not_visible", frameIds: [] },
            serialNumber: { value: null, status: "not_visible", frameIds: [] },
            condition: { status: "observed", damage: [], frameIds: ["RET-01"] },
        },
    ],
    totalItemCount: { value: 1, status: "observed", frameIds: ["RET-01"] },
    accessories: [],
    packagingCondition: { overall: "intact", observations: [] },
    imageConditions: { lighting: "good", focus: "sharp", continuity: "appears_continuous", notes: "" },
    privacy: { framesWithPeople: [], framesWithPersonalData: [] },
    suspectedInstructionText: [],
    unavailableInformation: [],
    uncertaintyNotes: [],
    overallConfidence: 0.88,
    ...overrides,
});

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(() => setVisionProvider(undefined));

describe("normalizeAnalysis", () => {
    it("drops unknown frame references, never keeps a guessed serial number, and clamps confidence", () => {
        const raw = sampleAnalysis({ overallConfidence: 1.7 });
        raw.items[0].color.frameIds = ["RET-01", "RET-99"];
        raw.items[0].serialNumber = { value: "SN-GUESS-123", status: "uncertain", frameIds: ["RET-01"] };
        raw.items[0].model = { value: "WH-100", status: "observed", frameIds: ["NOPE"] };

        const { result, notes } = normalizeAnalysis(raw, ["RET-01"]);
        expect(result.items[0].color.frameIds).toEqual(["RET-01"]);
        expect(result.items[0].serialNumber.value).toBeNull();
        expect(result.items[0].model.status).toBe("uncertain");
        expect(result.overallConfidence).toBe(1);
        expect(notes.join(" ")).toMatch(/RET-99/);
    });
});

describe("analyzeEvidence", () => {
    it("analyses real extracted frames with the demo provider and labels the result as demo", async () => {
        const order = await createOrder({
            demoScenario: "mismatch",
            product: { name: "Headphones", color: "black", model: "WH-100" },
        });
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), uploader);
        await extractFrames(media.id);
        setVisionProvider(new DemoVisionProvider());

        const record = await analyzeEvidence((await MediaEvidence.findById(media.id))!, order);
        expect(record.source).toBe("demo");
        expect(record.model).toBeNull();
        expect(record.framesAnalyzed).toHaveLength(8);
        expect(record.result.items[0].color.value).toBe("white");
        expect(record.result.uncertaintyNotes.join(" ")).toMatch(/DEMO DATA/);
    });

    it("never sends customer personal data to the vision provider", async () => {
        const order = await createOrder({
            customer: { name: "Tran Thi B", phone: "0987 654 321", address: "45 Le Loi Street, Hanoi" },
        });
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), uploader);
        await extractFrames(media.id);
        const seen: unknown[] = [];
        setVisionProvider({
            source: "ai",
            analyze: async (req) => {
                seen.push({ ...req, frames: req.frames.map((f) => f.frameId) });
                return { analysis: sampleAnalysis({ packageContentsFrameIds: [] }), model: "test-model" };
            },
        });
        await analyzeEvidence((await MediaEvidence.findById(media.id))!, order);
        const sent = JSON.stringify(seen);
        expect(sent).not.toMatch(/Tran Thi B|0987|Le Loi/);
        expect(sent).not.toMatch(new RegExp(order.orderId));
    });

    it("rejects provider output that breaks the schema", async () => {
        const order = await createOrder();
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), uploader);
        await extractFrames(media.id);
        setVisionProvider({
            source: "ai",
            analyze: async () => ({ analysis: { packageContents: "maybe" } as unknown as VisionAnalysis, model: "x" }),
        });
        await expect(analyzeEvidence((await MediaEvidence.findById(media.id))!, order)).rejects.toMatchObject({
            code: "AI_ERROR",
        });
    });

    it("refuses to analyse evidence whose frames were not extracted", async () => {
        const order = await createOrder();
        const media = await createMediaFromFile(order, "return", await makeVideo("normal"), uploader);
        await expect(analyzeEvidence(media, order)).rejects.toMatchObject({ code: "INVALID_STATE" });
    });
});
