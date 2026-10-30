import { analyzeItemTool } from "./analyzeItem";
import { buildClaimPackTool } from "./buildClaimPack";
import { compareItemsTool } from "./compareItems";
import { extractFramesTool } from "./extractFrames";
import { inspectVideoSegmentTool } from "./inspectVideoSegment";
import { linkMediaTool } from "./linkMedia";
import { lookupOrderTool } from "./lookupOrder";
import { notifyHumanTool } from "./notifyHuman";
import type { ToolDefinition } from "./types";
import { validateEvidenceTool } from "./validateEvidence";

export const allTools: ToolDefinition<any>[] = [
    lookupOrderTool,
    linkMediaTool,
    validateEvidenceTool,
    extractFramesTool,
    analyzeItemTool,
    compareItemsTool,
    buildClaimPackTool,
    inspectVideoSegmentTool,
    notifyHumanTool,
];
