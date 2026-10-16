import { z } from "zod";
import { activeMediaFor, validateEvidence } from "../../services/evidenceValidationService";
import { extractFrames } from "../../services/videoProcessingService";
import { ApiError } from "../../utils/errors";
import { transition } from "../agentState";
import { evidenceTypeSchema, refreshOrder } from "./helpers";
import { defineTool } from "./types";

const schema = z
    .object({
        evidenceType: evidenceTypeSchema,
        force: z.boolean().optional().describe("Re-extract even if frames already exist (use only when retrying)"),
    })
    .strict();

export const extractFramesTool = defineTool({
    name: "extract_frames",
    description:
        "Extract representative frames (with timestamps and brightness/sharpness scores) from the outbound or return video " +
        "using FFmpeg. Enforces duration and size limits. Call once per evidence type.",
    schema,
    plannerVisible: true,
    attemptKey: (args) => args.evidenceType,
    handler: async (args, ctx) => {
        const order = await refreshOrder(ctx);
        const media = await activeMediaFor(order, args.evidenceType);
        if (!media)
            throw new ApiError("VALIDATION_ERROR", `No ${args.evidenceType} evidence is linked`, [
                { retryable: false },
            ]);

        const result = await extractFrames(media.id, { force: args.force });
        ctx.extraction[args.evidenceType] = result;
        ctx.media[args.evidenceType] = (await activeMediaFor(order, args.evidenceType)) ?? media;

        // Check quality as soon as both videos are processed, before spending AI calls on unusable footage.
        let qualityIssues: unknown[] = [];
        if (ctx.extraction.outbound && ctx.extraction.return) {
            const check = await validateEvidence({ order, stage: "initial" });
            ctx.pendingEscalation = check.escalationReasons.filter((r) => r.blocking);
            qualityIssues = ctx.pendingEscalation;
        }
        await transition(ctx, "FRAME_EXTRACTION", `Frames extracted (${args.evidenceType})`);
        return {
            ...result,
            bothExtracted: Boolean(ctx.extraction.outbound && ctx.extraction.return),
            qualityIssues,
            nextStep: qualityIssues.length
                ? "notify_human"
                : ctx.extraction.outbound && ctx.extraction.return
                  ? "analyze_item"
                  : "extract_frames for the other evidence type",
        };
    },
});
