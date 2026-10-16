import { z } from "zod";
import { createReviewTask } from "../../services/reviewService";
import { knownEscalations, transition } from "../agentState";
import { defineTool } from "./types";

const schema = z
    .object({
        reason: z.string().trim().min(3).max(500),
        requiredAction: z.string().trim().max(500).optional(),
    })
    .strict();

export const notifyHumanTool = defineTool({
    name: "notify_human",
    description:
        "Create a human review task when evidence is insufficient, confidence is low, the order is high value, a tool keeps " +
        "failing, or another escalation rule applies. The backend attaches the detected escalation reasons and findings.",
    schema,
    plannerVisible: true,
    handler: async (args, ctx) => {
        const reasons = knownEscalations(ctx);
        await createReviewTask({
            inspection: ctx.inspection,
            principal: ctx.principal,
            reasons: reasons.length ? reasons : [{ code: "WORKFLOW_ERROR", blocking: true, message: args.reason }],
            agentNote: args.reason,
            requiredAction: args.requiredAction,
            findings: ctx.comparison?.findings,
            actorType: "agent",
        });
        ctx.reviewTaskCreated = true;
        ctx.pendingEscalation = [];
        await transition(ctx, "HUMAN_REVIEW", "Escalated to a human reviewer");
        return {
            reviewTaskCreated: true,
            reasons: reasons.map((r) => r.code),
            requiredAction: ctx.inspection.reviewTask?.requiredAction,
        };
    },
});
