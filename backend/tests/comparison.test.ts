import { describe, expect, it } from "vitest";
import { compareAnalyses, normalizeColor } from "../src/services/comparisonService";
import { demoPair } from "./fixtures";

const T = 0.7;

describe("compareAnalyses", () => {
    it("case 1: correct product and quantity produces no discrepancies", async () => {
        const { outbound, returned } = await demoPair("normal");
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(result.materialDiscrepancyCount).toBe(0);
        expect(result.findings.filter((f) => f.category !== "unverifiable_attribute")).toHaveLength(0);
        expect(result.meetsThreshold).toBe(true);
        expect(result.disclaimer).toMatch(/not proof of wrongdoing/);
    });

    it("case 2: one missing item is a high-severity quantity mismatch with frame citations", async () => {
        const { outbound, returned } = await demoPair("missing_item", { expectedQuantity: 2 });
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 2 }, T);
        const finding = result.findings.find((f) => f.category === "quantity_mismatch");
        expect(finding).toMatchObject({ severity: "high", certainty: "observed", nature: "visual_discrepancy" });
        expect(finding!.evidence.some((e) => e.type === "outbound" && e.timestampSec !== null)).toBe(true);
        expect(finding!.evidence.some((e) => e.type === "return")).toBe(true);
        expect(result.materialDiscrepancyCount).toBe(1);
    });

    it("case 2b: a missing accessory on a single-item order is reported", async () => {
        const { outbound, returned } = await demoPair("missing_item");
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(result.findings.find((f) => f.category === "missing_accessory")?.severity).toBe("medium");
    });

    it("case 3: a different printed model is a mismatch, a different colour first needs a look at both videos", async () => {
        const { outbound, returned } = await demoPair("mismatch");
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        const categories = result.findings.map((f) => f.category);
        expect(categories).toContain("model_mismatch");
        expect(categories).not.toContain("color_mismatch");
        expect(result.visualChecks).toMatchObject([{ attribute: "color", outboundValue: "black", status: "pending" }]);
        expect(result.maxSeverity).toBe("high");
    });

    it("case 4: an empty package is critical and suppresses per-item comparisons", async () => {
        const { outbound, returned } = await demoPair("empty_package");
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(result.findings[0]).toMatchObject({ category: "empty_package", severity: "critical" });
        expect(result.findings.map((f) => f.category)).not.toContain("missing_accessory");
    });

    it("case 5: a minor dent without product discrepancy is low severity and not material", async () => {
        const { outbound, returned } = await demoPair("minor_dent");
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(result.findings.find((f) => f.category === "packaging_condition_change")?.severity).toBe("low");
        expect(result.materialDiscrepancyCount).toBe(0);
        expect(result.summary).toMatch(/No material discrepancies/);
    });

    it("does not treat a colour difference under poor lighting as a mismatch", async () => {
        const { outbound, returned } = await demoPair("mismatch");
        returned.result.imageConditions.lighting = "poor";
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(result.findings.map((f) => f.category)).not.toContain("color_mismatch");
        expect(result.unverifiedAttributes).toContain("Colour");
    });

    it("treats colour synonyms and model-code formatting as equal", async () => {
        expect(normalizeColor("Space Grey")).toBe(normalizeColor("gray"));
        const { outbound, returned } = await demoPair("normal");
        returned.result.items[0].model.value = "wh 100";
        returned.result.items[0].color.value = "Matte Black";
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(result.materialDiscrepancyCount).toBe(0);
    });

    it("reports uncertain observations as unverifiable rather than as discrepancies", async () => {
        const { outbound, returned } = await demoPair("blurry");
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(result.materialDiscrepancyCount).toBe(0);
        expect(result.unverifiedAttributes).toEqual(expect.arrayContaining(["Item quantity", "Colour"]));
        expect(result.meetsThreshold).toBe(false);
    });
});
