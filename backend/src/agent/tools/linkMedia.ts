import { z } from "zod";
import { linkMedia } from "../../services/mediaService";
import { evidenceTypeSchema, refreshOrder, requireOrder } from "./helpers";
import { defineTool } from "./types";

const schema = z
    .object({
        mediaId: z.string().regex(/^[a-f0-9]{24}$/i, "mediaId must be a 24-character id"),
        evidenceType: evidenceTypeSchema,
    })
    .strict();

export const linkMediaTool = defineTool({
    name: "link_media",
    description:
        "Attach an already uploaded evidence video to the order being inspected. Validates ownership, media type and order " +
        "association. Never replaces existing evidence: replacement requires explicit human approval.",
    schema,
    plannerVisible: true,
    handler: async (args, ctx) => {
        const order = requireOrder(ctx);
        const media = await linkMedia(
            ctx.principal,
            { orderId: order.orderId, mediaId: args.mediaId, type: args.evidenceType },
            { actorType: "agent" },
        );
        await refreshOrder(ctx);
        return { linked: true, mediaId: media.id, evidenceType: media.type, status: media.status };
    },
});
