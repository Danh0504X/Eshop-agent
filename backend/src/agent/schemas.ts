import { z } from "zod";

/**
 * Structured output contract for the vision model.
 * Every observable attribute carries an explicit status so "not visible" is never confused with "absent".
 * Numeric ranges are enforced after parsing (normalizeAnalysis) rather than in the JSON schema.
 */
export const ObservationStatus = z.enum(["observed", "uncertain", "not_visible"]);
export type ObservationStatus = z.infer<typeof ObservationStatus>;

const stringObservation = z.object({
    value: z.string().nullable(),
    status: ObservationStatus,
    frameIds: z.array(z.string()),
});

const numberObservation = z.object({
    value: z.number().nullable(),
    status: ObservationStatus,
    frameIds: z.array(z.string()),
});

export const VisionAnalysisSchema = z.object({
    packageContents: z.enum(["items_present", "empty", "unclear"]),
    packageContentsFrameIds: z.array(z.string()),
    items: z.array(
        z.object({
            description: z.string(),
            productType: stringObservation,
            quantity: numberObservation,
            color: stringObservation,
            model: stringObservation,
            brand: stringObservation,
            serialNumber: stringObservation,
        }),
    ),
    totalItemCount: numberObservation,
    accessories: z.array(
        z.object({
            name: z.string(),
            status: z.enum(["present", "absent", "uncertain"]),
            frameIds: z.array(z.string()),
        }),
    ),
    packagingCondition: z.object({
        overall: z.enum(["intact", "minor_damage", "major_damage", "opened_or_tampered", "unclear"]),
        observations: z.array(
            z.object({
                description: z.string(),
                certainty: z.enum(["observed", "uncertain"]),
                frameIds: z.array(z.string()),
            }),
        ),
    }),
    visibleIdentifiers: z.array(
        z.object({
            text: z.string(),
            kind: z.enum(["order_id", "tracking_code", "sku", "barcode", "other"]),
            frameIds: z.array(z.string()),
        }),
    ),
    imageConditions: z.object({
        lighting: z.enum(["good", "poor", "unusable"]),
        focus: z.enum(["sharp", "blurry", "unusable"]),
        continuity: z.enum(["appears_continuous", "possible_cut", "cannot_assess"]),
        notes: z.string(),
    }),
    privacy: z.object({
        framesWithPeople: z.array(z.string()),
        framesWithPersonalData: z.array(z.string()),
    }),
    /** Text in the footage that read like instructions to the AI. Reported as data, never followed. */
    suspectedInstructionText: z.array(z.string()),
    unavailableInformation: z.array(z.string()),
    uncertaintyNotes: z.array(z.string()),
    overallConfidence: z.number(),
});
export type VisionAnalysis = z.infer<typeof VisionAnalysisSchema>;

/** What the inspection stores for each analysed evidence set. */
export interface AnalysisRecord {
    mediaId: string;
    evidenceType: "outbound" | "return";
    /** "ai" = real model output; "demo" = predefined demo data, never to be presented as AI analysis. */
    source: "ai" | "demo";
    model: string | null;
    framesAnalyzed: Array<{ frameId: string; timestampSec: number }>;
    analyzedAt: string;
    result: VisionAnalysis;
    /** Problems found while validating the model output (unknown frame IDs, dropped values, ...). */
    validationNotes: string[];
}

/** Clamp ranges, drop references to frames that were not sent, and null out unverified serial numbers. */
export const normalizeAnalysis = (
    raw: VisionAnalysis,
    sentFrameIds: string[],
): { result: VisionAnalysis; notes: string[] } => {
    const known = new Set(sentFrameIds);
    const notes: string[] = [];
    const filterIds = (ids: string[], where: string) => {
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length) notes.push(`Dropped unknown frame references ${unknown.join(", ")} in ${where}`);
        return ids.filter((id) => known.has(id));
    };
    const obs = <T extends { status: ObservationStatus; frameIds: string[]; value: unknown }>(
        o: T,
        where: string,
    ): T => {
        const frameIds = filterIds(o.frameIds, where);
        // An "observed" claim must point at a frame that was actually sent.
        const status = o.status === "observed" && frameIds.length === 0 ? "uncertain" : o.status;
        if (status !== o.status) notes.push(`${where}: downgraded to uncertain (no valid supporting frame)`);
        return { ...o, frameIds, status, value: status === "not_visible" ? null : o.value };
    };

    const result: VisionAnalysis = {
        ...raw,
        packageContentsFrameIds: filterIds(raw.packageContentsFrameIds, "packageContents"),
        items: raw.items.map((item, i) => {
            const serial = obs(item.serialNumber, `items[${i}].serialNumber`);
            return {
                ...item,
                productType: obs(item.productType, `items[${i}].productType`),
                quantity: obs(item.quantity, `items[${i}].quantity`),
                color: obs(item.color, `items[${i}].color`),
                model: obs(item.model, `items[${i}].model`),
                brand: obs(item.brand, `items[${i}].brand`),
                // Serial numbers are only kept when legibly observed: never guessed.
                serialNumber: serial.status === "observed" ? serial : { ...serial, value: null },
            };
        }),
        totalItemCount: obs(raw.totalItemCount, "totalItemCount"),
        accessories: raw.accessories.map((a, i) => ({ ...a, frameIds: filterIds(a.frameIds, `accessories[${i}]`) })),
        packagingCondition: {
            ...raw.packagingCondition,
            observations: raw.packagingCondition.observations.map((o, i) => ({
                ...o,
                frameIds: filterIds(o.frameIds, `packagingCondition.observations[${i}]`),
            })),
        },
        visibleIdentifiers: raw.visibleIdentifiers.map((v, i) => ({
            ...v,
            frameIds: filterIds(v.frameIds, `visibleIdentifiers[${i}]`),
        })),
        privacy: {
            framesWithPeople: raw.privacy.framesWithPeople.filter((id) => known.has(id)),
            framesWithPersonalData: raw.privacy.framesWithPersonalData.filter((id) => known.has(id)),
        },
        overallConfidence: Math.min(1, Math.max(0, Number.isFinite(raw.overallConfidence) ? raw.overallConfidence : 0)),
    };
    return { result, notes };
};
