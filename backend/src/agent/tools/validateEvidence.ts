import { z } from "zod";
import { activeMediaFor, validateEvidence } from "../../services/evidenceValidationService";
import { transition } from "../agentState";
import { refreshOrder } from "./helpers";
import { defineTool } from "./types";

export const validateEvidenceTool = defineTool({
    name: "validate_evidence",
    description:
        "Check evidence completeness and usability. Called once after lookup_order (presence, readability) and again after " +
        "compare_items as final verification (frame quality, continuity, visible order identifiers, confidence). " +
        "Returns escalation reasons; blocking reasons mean you must call notify_human.",
    schema: z.object({}).strict(),
    plannerVisible: true,
    handler: async (_args, ctx) => {
        const order = await refreshOrder(ctx);
        const final = ctx.state === "COMPARISON";
        const validation = await validateEvidence({
            order,
            stage: final ? "final" : "initial",
            analyses: final ? ctx.analyses : undefined,
            comparison: final ? ctx.comparison : undefined,
        });
        for (const type of ["outbound", "return"] as const) {
            const media = await activeMediaFor(order, type);
            if (media) ctx.media[type] = media;
        }

        if (final) ctx.finalValidation = validation;
        else ctx.initialValidation = validation;
        ctx.inspection.set("evidenceValidation", {
            initial: ctx.initialValidation ?? null,
            final: ctx.finalValidation ?? null,
        });
        ctx.pendingEscalation = validation.escalationReasons.filter((r) => r.blocking);
        await ctx.inspection.save();

        await transition(
            ctx,
            final ? "VERIFICATION" : "EVIDENCE_VALIDATION",
            validation.blocking ? "Blocking evidence issues found" : "Evidence checks passed",
        );
        return {
            stage: validation.stage,
            ok: validation.ok,
            blocking: validation.blocking,
            missing: validation.missing,
            escalationReasons: validation.escalationReasons,
            failedChecks: validation.checks.filter((c) => c.status === "fail" || c.status === "warn"),
            nextStep: validation.blocking
                ? "notify_human"
                : final
                  ? "build_claim_pack if material discrepancies exist, else finish"
                  : "extract_frames",
        };
    },
});
