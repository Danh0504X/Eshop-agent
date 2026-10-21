import { z } from "zod";
import type { AnalysisRecord } from "../schemas";
import { activeMediaFor } from "../../services/evidenceValidationService";
import { analyzeEvidence } from "../../services/visionService";
import { ApiError } from "../../utils/errors";
import { transition } from "../agentState";
import { evidenceTypeSchema, refreshOrder } from "./helpers";
import { defineTool } from "./types";

/**
 * What the planner sees of an analysis. Text found in the footage that looked like instructions is
 * reduced to a count so it can never reach the planner's context as a prompt-injection vector.
 */
export const summarizeAnalysis = (record: AnalysisRecord) => {
    const a = record.result;
    return {
        evidenceType: record.evidenceType,
        source: record.source,
        framesAnalyzed: record.framesAnalyzed,
        packageContents: a.packageContents,
        items: a.items.map((i) => ({
            description: i.description,
            productType: i.productType,
            quantity: i.quantity,
            color: i.color,
            model: i.model,
        })),
        totalItemCount: a.totalItemCount,
        accessories: a.accessories,
        packagingCondition: a.packagingCondition,
        visibleIdentifierKinds: a.visibleIdentifiers.map((v) => ({ kind: v.kind, frameIds: v.frameIds })),
        imageConditions: a.imageConditions,
        overallConfidence: a.overallConfidence,
        uncertaintyNotes: a.uncertaintyNotes,
        instructionLikeTextFound: a.suspectedInstructionText.length,
        validationNotes: record.validationNotes,
    };
};

export const analyzeItemTool = defineTool({
    name: "analyze_item",
    description:
        "Analyse the extracted frames of one evidence video with the vision model. Returns visible product type, quantity, " +
        "colour, model, accessories, packaging condition and image conditions, each marked observed/uncertain/not_visible " +
        "with supporting frame IDs. Call once for outbound and once for return.",
    schema: z.object({ evidenceType: evidenceTypeSchema }).strict(),
    plannerVisible: true,
    attemptKey: (args) => args.evidenceType,
    handler: async (args, ctx) => {
        if (!ctx.extraction[args.evidenceType]) {
            throw new ApiError("INVALID_STATE", `Extract ${args.evidenceType} frames first`, [{ retryable: false }]);
        }
        const order = await refreshOrder(ctx);
        const media = await activeMediaFor(order, args.evidenceType);
        if (!media)
            throw new ApiError("VALIDATION_ERROR", `No ${args.evidenceType} evidence is linked`, [
                { retryable: false },
            ]);

        const record = await analyzeEvidence(media, order, { deadlineMs: ctx.toolDeadline ?? ctx.deadline });
        ctx.analyses[args.evidenceType] = record;
        ctx.inspection.set(args.evidenceType === "outbound" ? "outboundAnalysis" : "returnAnalysis", record);
        await ctx.inspection.save();

        if (ctx.analyses.outbound && ctx.analyses.return) {
            await transition(ctx, "ITEM_ANALYSIS", "Both evidence videos analysed");
        }
        return {
            ...summarizeAnalysis(record),
            nextStep:
                ctx.analyses.outbound && ctx.analyses.return
                    ? "compare_items"
                    : "analyze_item for the other evidence type",
        };
    },
});
