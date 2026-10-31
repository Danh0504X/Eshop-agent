import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/models/AuditLog";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { Order, type OrderDoc } from "../src/models/Order";
import { buildClaimPack } from "../src/services/claimService";
import { compareAnalyses } from "../src/services/comparisonService";
import { validateEvidence } from "../src/services/evidenceValidationService";
import { buildReportModel, renderReportPdf } from "../src/services/reportService";
import { storage } from "../src/services/storageService";
import { extractFrames } from "../src/services/videoProcessingService";
import { redactText, toLatin1 } from "../src/utils/redact";
import type { DemoScenario } from "../src/services/vision/demoVisionProvider";
import {
    connectTestDb,
    createMediaFromFile,
    createOrder,
    createUser,
    disconnectTestDb,
    makeVideo,
    type TestUser,
} from "./helpers";
import { demoPair } from "./fixtures";

let owner: TestUser;

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-a" });
});
afterAll(disconnectTestDb);

const hex = (s: string) => Buffer.from(s, "latin1").toString("hex");

const setup = async (scenario: DemoScenario, overrides: Record<string, unknown> = {}) => {
    const orderId = `ORD-${new mongoose.Types.ObjectId().toString().slice(-6)}`;
    const created = await createOrder({ orderId, trackingCode: `TRK-${orderId}`, ...overrides });
    const out = await createMediaFromFile(created, "outbound", await makeVideo("normal"), owner.principal.userId);
    const ret = await createMediaFromFile(created, "return", await makeVideo("normal"), owner.principal.userId);
    await extractFrames(out.id);
    await extractFrames(ret.id);
    const order = (await Order.findById(created._id)) as OrderDoc;
    const { outbound, returned } = await demoPair(scenario, { expectedQuantity: order.expectedQuantity });
    const comparison = compareAnalyses(outbound, returned, order, 0.7);
    const validation = await validateEvidence({
        order,
        stage: "final",
        analyses: { outbound, return: returned },
        comparison,
    });
    const inspection = await Inspection.create({
        orderId,
        orderRef: order._id,
        shopId: order.shopId,
        warehouseId: order.warehouseId,
        task: `Inspect ${orderId}`,
        analysisMode: "demo",
        planner: "deterministic",
    });
    return {
        order,
        inspection,
        comparison,
        validation,
        analyses: { outbound, return: returned },
        media: { outbound: (await MediaEvidence.findById(out.id))!, return: (await MediaEvidence.findById(ret.id))! },
    };
};

describe("redactText", () => {
    it("redacts phones, e-mails, street addresses, labelled names and known customer values", () => {
        const { text, count } = redactText(
            "Label: recipient Nguyen Van A, phone 0912 345 678, +84 (28) 3822-1234, 12 Nguyen Trai Street, District 1, a.b@example.com. Note from Tran Thi B.",
            ["Tran Thi B"],
        );
        expect(text).not.toMatch(/0912|3822|Nguyen Trai|example\.com|Nguyen Van A|Tran Thi B/);
        expect(text).toMatch(/\[PHONE REDACTED\]/);
        expect(count).toBeGreaterThanOrEqual(6);
    });

    it("leaves ordinary product text and short numbers alone", () => {
        const input = "Model WH-100, quantity 2, frame RET-03 at 4.5s, value 120 USD";
        expect(redactText(input)).toEqual({ text: input, count: 0 });
    });

    it("transliterates Vietnamese for standard PDF fonts", () => {
        expect(toLatin1("Tai nghe không dây đen")).toBe("Tai nghe khong day den");
    });
});

describe("report and claim pack", () => {
    it("case 10: exported reports exclude customer data and redact personal data found in the footage", async () => {
        const ctx = await setup("mismatch", {
            customer: { name: "Le Van C", phone: "0900 111 222", address: "99 Hai Ba Trung Street, Hanoi" },
        });
        const sensitive = (await demoPair("sensitive_info")).returned;
        ctx.analyses.return.result.packagingCondition = sensitive.result.packagingCondition;
        // A frame cited by the findings is flagged as showing a person.
        ctx.analyses.return.result.privacy = { framesWithPeople: ["RET-05"], framesWithPersonalData: [] };
        const comparison = compareAnalyses(ctx.analyses.outbound, ctx.analyses.return, ctx.order, 0.7);
        const model = buildReportModel({
            ...ctx,
            comparison,
            summary: "Test summary for Le Van C",
            analysisMode: "demo",
        });

        const text = JSON.stringify(model);
        expect(text).not.toMatch(/Le Van C|0900 111 222|Hai Ba Trung|0912|Nguyen Trai|a\.nguyen@example\.com/);
        expect(model.redaction).toMatchObject({ fullyAnonymized: false, privacyReviewRequired: true });
        expect(model.redaction.textRedactions).toBeGreaterThan(0);
        expect(model.privacyNotes.join(" ")).toMatch(/NOT fully anonymized/);
        expect(model.banners[0]).toMatch(/AI-GENERATED DRAFT - PENDING HUMAN REVIEW/);
        expect(model.banners[1]).toMatch(/DEMO MODE/);
        expect(model.frames.find((f) => f.frameId === "RET-05")?.blur).toBe(true);
        expect(model.frames.find((f) => f.frameId === "OUT-05")?.blur).toBe(false);

        const pdf = await renderReportPdf(model, { compress: false });
        expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
        const raw = pdf.toString("latin1");
        expect(raw).toContain(hex("100")); // positive control: the product model (WH-100) is rendered
        for (const secret of ["0900", "0912", "Hai Ba", "Le Van"]) expect(raw).not.toContain(hex(secret));
    });

    it("builds a draft claim with a PDF, read back from the database, and audits it", async () => {
        const ctx = await setup("mismatch");
        const claim = await buildClaimPack({ ...ctx, principal: owner.principal, actorType: "agent" });

        expect(claim.status).toBe("pending_approval");
        expect(claim.aiGenerated).toBe(true);
        expect(claim.findings.map((f: { category: string }) => f.category)).toEqual(
            expect.arrayContaining(["model_mismatch"]),
        );
        expect(claim.evidenceReferences.length).toBeGreaterThan(0);
        expect(await storage().exists(claim.reportStorageKey!)).toBe(true);
        expect((await Inspection.findById(ctx.inspection._id))?.claimId?.toString()).toBe(claim.id);
        expect((await Order.findById(ctx.order._id))?.latestClaimId?.toString()).toBe(claim.id);
        expect(await AuditLog.countDocuments({ action: "claim.draft_created", claimId: claim.id })).toBe(1);

        const again = await buildClaimPack({ ...ctx, principal: owner.principal, actorType: "agent" });
        expect(again.id).toBe(claim.id);
        expect(await Claim.countDocuments({ inspectionId: ctx.inspection._id })).toBe(1);
    });

    it("refuses to draft a claim when evidence is blocking or nothing material was found", async () => {
        const normal = await setup("normal");
        await expect(
            buildClaimPack({ ...normal, principal: owner.principal, actorType: "agent" }),
        ).rejects.toMatchObject({
            code: "INVALID_STATE",
            message: expect.stringMatching(/no claim is needed/),
        });

        const lowConfidence = await setup("low_confidence");
        expect(lowConfidence.validation.blocking).toBe(true);
        await expect(
            buildClaimPack({ ...lowConfidence, principal: owner.principal, actorType: "agent" }),
        ).rejects.toMatchObject({
            message: expect.stringMatching(/blocking issues/),
        });
    });
});
