import { z } from "zod";
import { env } from "../../config/env";
import { applyProductMatch, type EvidenceRef } from "../../services/comparisonService";
import { activeMediaFor } from "../../services/evidenceValidationService";
import { verifyProductMatch } from "../../services/visionService";
import { ApiError } from "../../utils/errors";
import { assertBudget, budgetRemaining, consumeBudget } from "../agentState";
import { storeComparison } from "./compareItems";
import { refreshOrder } from "./helpers";
import { defineTool } from "./types";

export const verifyProductMatchTool = defineTool({
    name: "verify_product_match",
    description:
        "Use when compare_items reports pending visual checks: the two written descriptions of the product differ, which " +
        "may only be wording. Sends frames of both videos to the vision model in one request and asks whether the product " +
        "looks the same. 'same' drops the difference, 'different' makes it a finding, 'uncertain' sends it to a person. " +
        "It cannot change findings from printed model codes, quantities or damage. Uses one AI request.",
    schema: z.object({}).strict(),
    plannerVisible: true,
    handler: async (_args, ctx) => {
        const { comparison } = ctx;
        const { outbound, return: returned } = ctx.analyses;
        if (!comparison || !outbound || !returned) {
            throw new ApiError("INVALID_STATE", "Run compare_items first", [{ retryable: false }]);
        }
        const pending = comparison.visualChecks.filter((c) => c.status === "pending");
        if (!pending.length) {
            throw new ApiError("INVALID_STATE", "No visual check is pending; call validate_evidence", [
                { retryable: false },
            ]);
        }
        assertBudget(ctx, { aiRequests: 1, frames: env.MAX_FRAMES_PER_MATCH_CHECK * 2 });

        const order = await refreshOrder(ctx);
        const [outboundMedia, returnMedia] = await Promise.all([
            activeMediaFor(order, "outbound"),
            activeMediaFor(order, "return"),
        ]);
        if (!outboundMedia || !returnMedia) {
            throw new ApiError("VALIDATION_ERROR", "Both evidence videos must be linked", [{ retryable: false }]);
        }

        // The AI request is charged before the call: a failed call still used the provider quota.
        consumeBudget(ctx, { aiRequests: 1 });
        const record = await verifyProductMatch(
            { outbound: outboundMedia, return: returnMedia },
            { outbound, return: returned },
            order,
            { deadlineMs: ctx.toolDeadline ?? ctx.deadline },
        );
        consumeBudget(ctx, { frames: record.framesAnalyzed.length });

        const { result } = record;
        const timeOf = (frameId: string) =>
            record.framesAnalyzed.find((f) => f.frameId === frameId)?.timestampSec ?? null;
        const evidence: EvidenceRef[] = [
            ...result.outboundFrameIds.map((frameId) => ({
                frameId,
                type: "outbound" as const,
                timestampSec: timeOf(frameId),
            })),
            ...result.returnFrameIds.map((frameId) => ({
                frameId,
                type: "return" as const,
                timestampSec: timeOf(frameId),
            })),
        ];
        const updated = applyProductMatch(comparison, result, evidence);
        storeComparison(ctx, updated);
        const checks = pending.map((c) => ({
            attribute: c.attribute,
            label: c.label,
            outboundValue: c.outboundValue,
            returnValue: c.returnValue,
            verdict: result[c.attribute],
        }));
        ctx.inspection.set("productMatch", { ...record, checks });
        await ctx.inspection.save();

        return {
            source: record.source,
            checks,
            reason: result.reason,
            overallConfidence: result.overallConfidence,
            framesAnalyzed: record.framesAnalyzed,
            outboundFrameIds: result.outboundFrameIds,
            returnFrameIds: result.returnFrameIds,
            validationNotes: record.validationNotes,
            // Text from the footage is reduced to a count so it can never reach the planner as instructions.
            instructionLikeTextFound: result.suspectedInstructionText.length,
            materialDiscrepancyCount: updated.materialDiscrepancyCount,
            budgetRemaining: budgetRemaining(ctx),
            nextStep: "validate_evidence (final verification)",
        };
    },
});
