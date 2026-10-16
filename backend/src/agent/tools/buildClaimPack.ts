import { z } from "zod";
import { buildClaimPack } from "../../services/claimService";
import { ApiError } from "../../utils/errors";
import { transition } from "../agentState";
import { requireOrder } from "./helpers";
import { defineTool } from "./types";

export const buildClaimPackTool = defineTool({
    name: "build_claim_pack",
    description:
        "Generate a draft claim with a neutral summary, findings, supporting frames, timestamps and uncertainty notes, and " +
        "export a redacted PDF marked AI-generated and pending human review. Only allowed after final verification with no " +
        "blocking issues and at least one material discrepancy. Never submits anything externally.",
    schema: z.object({}).strict(),
    plannerVisible: true,
    handler: async (_args, ctx) => {
        const order = requireOrder(ctx);
        const { comparison, finalValidation } = ctx;
        const { outbound, return: returned } = ctx.analyses;
        if (!comparison || !finalValidation || !outbound || !returned || !ctx.media.outbound || !ctx.media.return) {
            throw new ApiError("INVALID_STATE", "Complete comparison and final verification first", [
                { retryable: false },
            ]);
        }
        const claim = await buildClaimPack({
            principal: ctx.principal,
            inspection: ctx.inspection,
            order,
            comparison,
            validation: finalValidation,
            analyses: { outbound, return: returned },
            media: { outbound: ctx.media.outbound, return: ctx.media.return },
            actorType: "agent",
        });
        ctx.claimId = claim.id;
        ctx.inspection.claimId = claim._id;
        await transition(ctx, "CLAIM_DRAFT", `Draft claim ${claim.id} created`);
        return {
            claimId: claim.id,
            status: claim.status,
            findings: claim.findings.length,
            reportGenerated: Boolean(claim.reportStorageKey),
            note: "Draft is pending human approval. It has not been submitted anywhere.",
        };
    },
});
