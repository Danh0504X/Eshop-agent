import type { z } from "zod";
import type { AgentContext, ToolName } from "../agentState";

export interface ToolError {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
}

export type ToolResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: ToolError };

export interface ToolDefinition<A = unknown> {
    name: ToolName;
    description: string;
    schema: z.ZodType<A>;
    /** false for tools only an authorized user may trigger (e.g. track_refund); the agent never sees them. */
    plannerVisible: boolean;
    /** Retry bucket key so retries are counted per target (e.g. per evidence type). */
    attemptKey?: (args: A) => string;
    handler: (args: A, ctx: AgentContext) => Promise<Record<string, unknown>>;
}

export const defineTool = <A>(tool: ToolDefinition<A>): ToolDefinition<A> => tool;
