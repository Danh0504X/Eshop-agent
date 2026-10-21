import type { AnalysisRecord, ObservationStatus, VisionAnalysis } from "../agent/schemas";

/**
 * Deterministic comparison of outbound vs return analyses.
 * Findings describe observable visual discrepancies only. They are never proof of wrongdoing.
 */

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type FindingCategory =
    | "empty_package"
    | "quantity_mismatch"
    | "outbound_quantity_differs_from_order"
    | "product_type_mismatch"
    | "model_mismatch"
    | "color_mismatch"
    | "missing_accessory"
    | "packaging_condition_change"
    | "product_condition_change"
    | "unverifiable_attribute";

export interface EvidenceRef {
    frameId: string;
    type: "outbound" | "return";
    timestampSec: number | null;
}

export interface Finding {
    id: string;
    category: FindingCategory;
    severity: Severity;
    /** Model-reported confidence carried through (min of both analyses). Not a calibrated probability. */
    confidence: number;
    certainty: "observed" | "uncertain";
    description: string;
    outboundObservation: string | null;
    returnObservation: string | null;
    evidence: EvidenceRef[];
    nature: "visual_discrepancy";
}

export interface ComparisonResult {
    findings: Finding[];
    /** Findings of medium severity or above that are based on clear observations. */
    materialDiscrepancyCount: number;
    maxSeverity: Severity;
    overallConfidence: number;
    meetsThreshold: boolean;
    unverifiedAttributes: string[];
    summary: string;
    disclaimer: string;
    comparedAt: string;
}

export const DISCLAIMER =
    "These are observable differences between two recordings. They are not proof of wrongdoing by any person; " +
    "differences can result from camera angle, lighting, packing practice or recording gaps. A human must review before any action.";

const severityRank = (s: Severity) => SEVERITIES.indexOf(s);

const COLOR_SYNONYMS: Record<string, string> = {
    grey: "gray",
    "space gray": "gray",
    "space grey": "gray",
    charcoal: "gray",
    graphite: "gray",
    navy: "blue",
    "dark blue": "blue",
    "navy blue": "blue",
    "light blue": "blue",
    "off white": "white",
    "off-white": "white",
    ivory: "white",
    cream: "white",
    "jet black": "black",
    "matte black": "black",
    midnight: "black",
    silver: "gray",
    gold: "gold",
    "rose gold": "pink",
    beige: "brown",
    tan: "brown",
};

export const normalizeColor = (value: string): string => {
    const v = value.toLowerCase().trim().replace(/\s+/g, " ");
    return COLOR_SYNONYMS[v] ?? v;
};

export const normalizeCode = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

const normalizeText = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .trim();

const PACKAGING_RANK: Record<VisionAnalysis["packagingCondition"]["overall"], number> = {
    intact: 0,
    minor_damage: 1,
    major_damage: 2,
    opened_or_tampered: 2,
    unclear: -1,
};

interface Ctx {
    out: AnalysisRecord;
    ret: AnalysisRecord;
    confidence: number;
    poorConditions: boolean;
    findings: Finding[];
    unverified: string[];
}

const refs = (record: AnalysisRecord, ids: string[]): EvidenceRef[] =>
    ids.map((frameId) => ({
        frameId,
        type: record.evidenceType,
        timestampSec: record.framesAnalyzed.find((f) => f.frameId === frameId)?.timestampSec ?? null,
    }));

const add = (ctx: Ctx, f: Omit<Finding, "id" | "nature" | "confidence"> & { confidence?: number }) => {
    ctx.findings.push({
        ...f,
        id: `F${String(ctx.findings.length + 1).padStart(2, "0")}`,
        confidence: f.confidence ?? ctx.confidence,
        nature: "visual_discrepancy",
    });
};

const unverifiable = (ctx: Ctx, attribute: string, out: string | null, ret: string | null, evidence: EvidenceRef[]) => {
    ctx.unverified.push(attribute);
    add(ctx, {
        category: "unverifiable_attribute",
        severity: "info",
        certainty: "uncertain",
        description: `${attribute} could not be compared reliably from the available frames.`,
        outboundObservation: out,
        returnObservation: ret,
        evidence,
    });
};

const describe = (o: { value: unknown; status: ObservationStatus }) =>
    o.status === "not_visible" || o.value === null ? `not visible` : `${String(o.value)} (${o.status})`;

export const compareAnalyses = (
    outbound: AnalysisRecord,
    returned: AnalysisRecord,
    order: { expectedQuantity: number },
    threshold: number,
): ComparisonResult => {
    const out = outbound.result;
    const ret = returned.result;
    const ctx: Ctx = {
        out: outbound,
        ret: returned,
        confidence: Math.min(out.overallConfidence, ret.overallConfidence),
        // Colour judgements under poor lighting or blur are not reliable enough to call a mismatch.
        poorConditions: [out, ret].some(
            (a) => a.imageConditions.lighting !== "good" || a.imageConditions.focus !== "sharp",
        ),
        findings: [],
        unverified: [],
    };

    // 1. Package contents
    if (ret.packageContents === "empty" && out.packageContents === "items_present") {
        add(ctx, {
            category: "empty_package",
            severity: "critical",
            certainty: "observed",
            description:
                "The return recording shows an opened package with no product inside; the outbound recording showed items packed.",
            outboundObservation: "items present",
            returnObservation: "package appears empty",
            evidence: [...refs(outbound, out.packageContentsFrameIds), ...refs(returned, ret.packageContentsFrameIds)],
        });
    } else if (ret.packageContents === "unclear" || out.packageContents === "unclear") {
        unverifiable(ctx, "Package contents", out.packageContents, ret.packageContents, [
            ...refs(outbound, out.packageContentsFrameIds),
            ...refs(returned, ret.packageContentsFrameIds),
        ]);
    }
    const returnEmpty = ret.packageContents === "empty";

    // 2. Quantity
    const oq = out.totalItemCount;
    const rq = ret.totalItemCount;
    if (oq.status === "observed" && oq.value !== null && oq.value !== order.expectedQuantity) {
        add(ctx, {
            category: "outbound_quantity_differs_from_order",
            severity: "medium",
            certainty: "observed",
            description: `The outbound recording shows ${oq.value} item(s) packed, but the order expects ${order.expectedQuantity}.`,
            outboundObservation: describe(oq),
            returnObservation: null,
            evidence: refs(outbound, oq.frameIds),
        });
    }
    if (!returnEmpty) {
        if (oq.status === "observed" && rq.status === "observed" && oq.value !== null && rq.value !== null) {
            if (rq.value < oq.value) {
                add(ctx, {
                    category: "quantity_mismatch",
                    severity: "high",
                    certainty: "observed",
                    description: `The return recording shows ${rq.value} item(s); ${oq.value} were visible when packed.`,
                    outboundObservation: describe(oq),
                    returnObservation: describe(rq),
                    evidence: [...refs(outbound, oq.frameIds), ...refs(returned, rq.frameIds)],
                });
            } else if (rq.value > oq.value) {
                add(ctx, {
                    category: "quantity_mismatch",
                    severity: "low",
                    certainty: "observed",
                    description: `The return recording shows more items (${rq.value}) than were visible when packed (${oq.value}).`,
                    outboundObservation: describe(oq),
                    returnObservation: describe(rq),
                    evidence: [...refs(outbound, oq.frameIds), ...refs(returned, rq.frameIds)],
                });
            }
        } else {
            unverifiable(ctx, "Item quantity", describe(oq), describe(rq), [
                ...refs(outbound, oq.frameIds),
                ...refs(returned, rq.frameIds),
            ]);
        }
    }

    // 3. Product characteristics of the primary item
    const oi = out.items[0];
    const ri = ret.items[0];
    if (oi && ri && !returnEmpty) {
        const attrs: Array<{
            key: "productType" | "model" | "color";
            label: string;
            category: FindingCategory;
            severity: Severity;
            norm: (v: string) => string;
        }> = [
            {
                key: "productType",
                label: "Product type",
                category: "product_type_mismatch",
                severity: "high",
                norm: normalizeText,
            },
            { key: "model", label: "Model", category: "model_mismatch", severity: "high", norm: normalizeCode },
            { key: "color", label: "Colour", category: "color_mismatch", severity: "medium", norm: normalizeColor },
        ];
        for (const attr of attrs) {
            const o = oi[attr.key];
            const r = ri[attr.key];
            const evidence = [...refs(outbound, o.frameIds), ...refs(returned, r.frameIds)];
            if (o.status === "not_visible" && r.status === "not_visible") continue;
            const bothObserved = o.status === "observed" && r.status === "observed" && o.value && r.value;
            if (!bothObserved) {
                unverifiable(ctx, attr.label, describe(o), describe(r), evidence);
                continue;
            }
            if (attr.norm(o.value!) === attr.norm(r.value!)) continue;
            if (attr.key === "color" && ctx.poorConditions) {
                unverifiable(ctx, attr.label, describe(o), describe(r), evidence);
                continue;
            }
            add(ctx, {
                category: attr.category,
                severity: attr.severity,
                certainty: "observed",
                description: `${attr.label} differs: "${o.value}" when packed, "${r.value}" in the return.`,
                outboundObservation: describe(o),
                returnObservation: describe(r),
                evidence,
            });
        }
    }

    // 4. Accessories
    if (!returnEmpty) {
        for (const acc of out.accessories.filter((a) => a.status === "present")) {
            const match = ret.accessories.find((a) => normalizeText(a.name) === normalizeText(acc.name));
            if (match?.status === "present") continue;
            const evidence = [...refs(outbound, acc.frameIds), ...refs(returned, match?.frameIds ?? [])];
            if (match?.status === "absent") {
                add(ctx, {
                    category: "missing_accessory",
                    severity: "medium",
                    certainty: "observed",
                    description: `Accessory "${acc.name}" was visible when packed but is not present in the return recording.`,
                    outboundObservation: "present",
                    returnObservation: "absent",
                    evidence,
                });
            } else {
                unverifiable(ctx, `Accessory "${acc.name}"`, "present", match ? "uncertain" : "not checked", evidence);
            }
        }
    }

    // 5. Packaging condition
    const op = PACKAGING_RANK[out.packagingCondition.overall];
    const rp = PACKAGING_RANK[ret.packagingCondition.overall];
    const packagingEvidence = [
        ...refs(
            outbound,
            out.packagingCondition.observations.flatMap((o) => o.frameIds),
        ),
        ...refs(
            returned,
            ret.packagingCondition.observations.flatMap((o) => o.frameIds),
        ),
    ];
    if (op >= 0 && rp > op) {
        add(ctx, {
            category: "packaging_condition_change",
            severity: rp >= 2 ? "medium" : "low",
            certainty: ret.packagingCondition.observations.some((o) => o.certainty === "observed")
                ? "observed"
                : "uncertain",
            description: `Packaging condition changed from "${out.packagingCondition.overall}" to "${ret.packagingCondition.overall}".`,
            outboundObservation: out.packagingCondition.overall,
            returnObservation: [
                ret.packagingCondition.overall,
                ...ret.packagingCondition.observations.map((o) => o.description),
            ].join("; "),
            evidence: packagingEvidence,
        });
    } else if (op < 0 || rp < 0) {
        unverifiable(
            ctx,
            "Packaging condition",
            out.packagingCondition.overall,
            ret.packagingCondition.overall,
            packagingEvidence,
        );
    }

    // 6. Product condition (damage on the item itself)
    if (oi && ri && !returnEmpty) compareProductCondition(ctx, oi.condition, ri.condition);

    const material = ctx.findings.filter(
        (f) => severityRank(f.severity) >= severityRank("medium") && f.certainty === "observed",
    );
    const maxSeverity = ctx.findings.reduce<Severity>(
        (max, f) => (severityRank(f.severity) > severityRank(max) ? f.severity : max),
        "info",
    );
    return {
        findings: ctx.findings,
        materialDiscrepancyCount: material.length,
        maxSeverity,
        overallConfidence: ctx.confidence,
        meetsThreshold: ctx.confidence >= threshold,
        unverifiedAttributes: ctx.unverified,
        summary: summarize(material, ctx.findings, ctx.unverified),
        disclaimer: DISCLAIMER,
        comparedAt: new Date().toISOString(),
    };
};

type ProductCondition = VisionAnalysis["items"][number]["condition"];
type Damage = ProductCondition["damage"][number];

/** Breakage outranks cosmetic marks; "major" lifts a cosmetic mark to medium. */
const damageSeverity = (d: Damage): Severity => {
    if (d.kind === "crack" || d.kind === "broken" || d.kind === "missing_part") return "high";
    return d.severity === "major" ? "medium" : "low";
};

/**
 * Damage visible in the return but not when packed is reported as a visual difference only: the video
 * cannot show when or how it happened. Uncertain sightings, or an outbound view that did not show the
 * surface clearly, are reported as unverifiable rather than as new damage.
 */
const compareProductCondition = (ctx: Ctx, out: ProductCondition, ret: ProductCondition) => {
    if (out.status === "not_visible" && ret.status === "not_visible") return;
    const outRefs = refs(ctx.out, [...out.frameIds, ...out.damage.flatMap((d) => d.frameIds)]);
    const describeCondition = (c: ProductCondition) =>
        c.status === "not_visible"
            ? "surface not visible"
            : c.damage.length
              ? c.damage.map((d) => `${d.kind} (${d.severity}, ${d.certainty})`).join(", ")
              : `no visible damage (${c.status})`;

    const preexisting = new Set(out.damage.map((d) => d.kind));
    const newDamage = ret.damage.filter((d) => !preexisting.has(d.kind));
    if (newDamage.length === 0) {
        if (ret.status !== "observed" || out.status !== "observed") {
            unverifiable(ctx, "Product condition", describeCondition(out), describeCondition(ret), [
                ...outRefs,
                ...refs(ctx.ret, ret.frameIds),
            ]);
        }
        return;
    }

    for (const d of newDamage) {
        const evidence = [...outRefs, ...refs(ctx.ret, d.frameIds)];
        // Only a clear outbound view of the surface can show the damage was absent when packed.
        if (d.certainty !== "observed" || out.status !== "observed") {
            unverifiable(
                ctx,
                `Product condition (${d.kind})`,
                describeCondition(out),
                describeCondition(ret),
                evidence,
            );
            continue;
        }
        add(ctx, {
            category: "product_condition_change",
            severity: damageSeverity(d),
            certainty: "observed",
            description:
                `The return recording shows ${d.severity} ${d.kind.replace("_", " ")} (${d.description}) that was not visible ` +
                "when packed. The recordings cannot show when or how it occurred.",
            outboundObservation: describeCondition(out),
            returnObservation: describeCondition(ret),
            evidence,
        });
    }
};

const summarize = (material: Finding[], all: Finding[], unverified: string[]): string => {
    const parts: string[] = [];
    if (material.length === 0) {
        const minor = all.filter((f) => f.severity === "low");
        parts.push(
            minor.length
                ? `No material discrepancies observed. Minor observations: ${minor.map((f) => f.description).join(" ")}`
                : "No material discrepancies observed between the outbound and return recordings.",
        );
    } else {
        parts.push(
            `${material.length} visual discrepancy(ies) observed: ${material.map((f) => f.description).join(" ")}`,
        );
    }
    if (unverified.length) parts.push(`Could not verify: ${unverified.join(", ")}.`);
    return parts.join(" ");
};
