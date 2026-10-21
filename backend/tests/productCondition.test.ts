import { describe, expect, it } from "vitest";
import { normalizeAnalysis, type AnalysisRecord } from "../src/agent/schemas";
import { compareAnalyses } from "../src/services/comparisonService";
import { demoPair, demoRecord } from "./fixtures";

type Damage = AnalysisRecord["result"]["items"][number]["condition"]["damage"][number];

const T = 0.7;
const damage = (overrides: Partial<Damage> = {}): Damage => ({
    kind: "scratch",
    severity: "minor",
    description: "Scratch on the front casing",
    certainty: "observed",
    frameIds: ["RET-05"],
    ...overrides,
});

/** Outbound shows a clean product; the return gets the given damage. */
const withReturnDamage = async (...items: Damage[]) => {
    const { outbound, returned } = await demoPair("normal");
    returned.result.items[0].condition = { status: "observed", damage: items, frameIds: ["RET-05"] };
    return { outbound, returned };
};

const conditionFindings = (result: ReturnType<typeof compareAnalyses>) =>
    result.findings.filter((f) => f.category === "product_condition_change");

describe("product condition comparison", () => {
    it("reports a minor scratch seen only in the return as a low, non-material difference", async () => {
        const { outbound, returned } = await demoPair("product_scratch");
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        const [finding] = conditionFindings(result);
        expect(finding).toMatchObject({ severity: "low", certainty: "observed", nature: "visual_discrepancy" });
        expect(finding.evidence.some((e) => e.type === "return" && e.timestampSec !== null)).toBe(true);
        expect(finding.description).toMatch(/cannot show when or how it occurred/);
        expect(result.materialDiscrepancyCount).toBe(0);
    });

    it("grades major marks as medium and breakage as high", async () => {
        const dent = await withReturnDamage(damage({ kind: "dent", severity: "major" }));
        const major = compareAnalyses(dent.outbound, dent.returned, { expectedQuantity: 1 }, T);
        expect(conditionFindings(major)[0].severity).toBe("medium");
        expect(major.materialDiscrepancyCount).toBe(1);

        const cracked = await withReturnDamage(damage({ kind: "crack" }));
        const crack = compareAnalyses(cracked.outbound, cracked.returned, { expectedQuantity: 1 }, T);
        expect(conditionFindings(crack)[0].severity).toBe("high");
    });

    it("ignores damage that was already visible when packed", async () => {
        const { outbound, returned } = await withReturnDamage(damage());
        outbound.result.items[0].condition = {
            status: "observed",
            damage: [damage({ frameIds: ["OUT-05"] })],
            frameIds: ["OUT-05"],
        };
        const result = compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T);
        expect(conditionFindings(result)).toHaveLength(0);
    });

    it("treats uncertain damage, or an unclear outbound view, as unverifiable rather than as new damage", async () => {
        const uncertain = await withReturnDamage(damage({ certainty: "uncertain" }));
        const a = compareAnalyses(uncertain.outbound, uncertain.returned, { expectedQuantity: 1 }, T);
        expect(conditionFindings(a)).toHaveLength(0);
        expect(a.unverifiedAttributes).toContain("Product condition (scratch)");

        const unclearOutbound = await withReturnDamage(damage({ kind: "dent", severity: "major" }));
        unclearOutbound.outbound.result.items[0].condition = { status: "not_visible", damage: [], frameIds: [] };
        const b = compareAnalyses(unclearOutbound.outbound, unclearOutbound.returned, { expectedQuantity: 1 }, T);
        expect(conditionFindings(b)).toHaveLength(0);
        expect(b.unverifiedAttributes).toContain("Product condition (dent)");
        expect(b.materialDiscrepancyCount).toBe(0);
    });

    it("reports nothing when neither view shows the surface, and unverifiable when only one does", async () => {
        const { outbound, returned } = await demoPair("normal");
        outbound.result.items[0].condition = { status: "not_visible", damage: [], frameIds: [] };
        returned.result.items[0].condition = { status: "not_visible", damage: [], frameIds: [] };
        expect(compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T).unverifiedAttributes).not.toContain(
            "Product condition",
        );

        returned.result.items[0].condition = { status: "observed", damage: [], frameIds: ["RET-05"] };
        expect(compareAnalyses(outbound, returned, { expectedQuantity: 1 }, T).unverifiedAttributes).toContain(
            "Product condition",
        );
    });
});

describe("product condition normalisation", () => {
    it("drops damage on a surface marked not visible and downgrades ungrounded damage", async () => {
        const record = await demoRecord("normal", "return");
        record.result.items[0].condition = {
            status: "not_visible",
            damage: [damage()],
            frameIds: [],
        };
        const hidden = normalizeAnalysis(record.result, ["RET-05"]);
        expect(hidden.result.items[0].condition).toEqual({ status: "not_visible", damage: [], frameIds: [] });
        expect(hidden.notes.join(" ")).toMatch(/surface marked not visible/);

        record.result.items[0].condition = {
            status: "observed",
            damage: [damage({ frameIds: ["RET-99"] })],
            frameIds: ["RET-05"],
        };
        const ungrounded = normalizeAnalysis(record.result, ["RET-05"]);
        expect(ungrounded.result.items[0].condition.damage[0]).toMatchObject({ certainty: "uncertain", frameIds: [] });
    });
});
