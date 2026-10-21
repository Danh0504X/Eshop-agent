import { z } from "zod";
import { env } from "../../config/env";
import { compareAnalyses } from "../../services/comparisonService";
import { ApiError } from "../../utils/errors";
import { invalidateVerification, transition } from "../agentState";
import { requireOrder } from "./helpers";
import { defineTool } from "./types";

export const compareItemsTool = defineTool({
    name: "compare_items",
    description:
        "Compare the outbound and return analyses. Returns structured findings (category, severity, confidence, certainty, " +
        "supporting frames with timestamps) and attributes that could not be verified. Findings are visual discrepancies, " +
        "not proof of wrongdoing.",
    schema: z.object({}).strict(),
    plannerVisible: true,
    handler: async (_args, ctx) => {
        const order = requireOrder(ctx);
        const { outbound, return: returned } = ctx.analyses;
        if (!outbound || !returned) {
            throw new ApiError("INVALID_STATE", "Analyse both outbound and return evidence first", [
                { retryable: false },
            ]);
        }
        const comparison = compareAnalyses(outbound, returned, order, env.CONFIDENCE_THRESHOLD);
        ctx.comparison = comparison;
        // A new comparison must be verified again before any claim.
        invalidateVerification(ctx);

        const refs = new Map<string, { frameId: string; mediaId: string; type: string; timestampSec?: number }>();
        for (const f of comparison.findings) {
            for (const e of f.evidence) {
                refs.set(e.frameId, {
                    frameId: e.frameId,
                    mediaId: ctx.analyses[e.type]?.mediaId ?? "",
                    type: e.type,
                    timestampSec: e.timestampSec ?? undefined,
                });
            }
        }
        ctx.inspection.set({
            comparison,
            confidence: {
                score: comparison.overallConfidence,
                threshold: env.CONFIDENCE_THRESHOLD,
                meetsThreshold: comparison.meetsThreshold,
                calibrated: false,
            },
            uncertainty: [
                ...comparison.unverifiedAttributes.map((a) => `Not verifiable: ${a}`),
                ...outbound.result.uncertaintyNotes,
                ...returned.result.uncertaintyNotes,
            ],
            frameReferences: [...refs.values()],
        });
        await ctx.inspection.save();
        await transition(ctx, "COMPARISON", `${comparison.materialDiscrepancyCount} material discrepancy(ies)`);
        return { ...comparison, nextStep: "validate_evidence (final verification)" };
    },
});
