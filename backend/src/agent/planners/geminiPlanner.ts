import { FunctionCallingConfigMode, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { env } from "../../config/env";
import {
    assertUsableResponse,
    callGemini,
    createGeminiClient,
    type GeminiModelsClient,
} from "../../services/ai/gemini";
import { aiError } from "../../services/vision/errors";
import { ALLOWED_TOOLS, type AgentContext } from "../agentState";
import { AGENT_SYSTEM_PROMPT } from "../prompts";
import { plannerToolSpecs } from "../toolRegistry";
import type { Planner, PlannerDecision, ToolOutcome } from "./types";

const LABEL = "Planner";
const MAX_RESULT_CHARS = 12_000;

/**
 * Compact view of the run that accompanies every tool result, so the model decides from current evidence
 * rather than from a remembered script. Contains no customer data.
 */
export const agentSnapshot = (ctx: AgentContext) => ({
    workflowState: ctx.state,
    allowedTools: ALLOWED_TOOLS[ctx.state],
    evidence: {
        outboundFramesExtracted: Boolean(ctx.extraction.outbound),
        returnFramesExtracted: Boolean(ctx.extraction.return),
        outboundAnalyzed: Boolean(ctx.analyses.outbound),
        returnAnalyzed: Boolean(ctx.analyses.return),
        compared: Boolean(ctx.comparison),
        materialDiscrepancies: ctx.comparison?.materialDiscrepancyCount ?? null,
        finalVerificationDone: Boolean(ctx.finalValidation),
        claimDrafted: Boolean(ctx.claimId),
        humanReviewRequested: ctx.reviewTaskCreated,
    },
    pendingEscalation: ctx.pendingEscalation.map((r) => r.code),
    remainingSeconds: Math.max(0, Math.round((ctx.deadline - Date.now()) / 1000)),
});

/** Tool output as a functionResponse payload, truncated so one large result cannot flood the context. */
const responsePayload = (outcome: ToolOutcome, ctx: AgentContext): Record<string, unknown> => {
    const body = outcome.result.ok ? { output: outcome.result.data } : { error: outcome.result.error };
    const json = JSON.stringify(body);
    const result = json.length > MAX_RESULT_CHARS ? { truncatedJson: `${json.slice(0, MAX_RESULT_CHARS)}...` } : body;
    return { ...result, agentState: agentSnapshot(ctx) };
};

const functionDeclarations = (): FunctionDeclaration[] =>
    plannerToolSpecs().map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));

/**
 * Gemini planner using function calling. Gemini chooses each next tool from the tool results it has seen;
 * the backend tool registry remains the only place tools are authorised, validated and executed.
 *
 * History handling: every model turn is appended exactly as returned (including thought signatures, which
 * Gemini 3 requires on later turns); this class never creates, edits or drops parts of a model turn.
 */
export class GeminiPlanner implements Planner {
    readonly kind = "llm" as const;
    readonly name = "gemini" as const;
    private client: GeminiModelsClient | undefined;
    private readonly contents: Content[] = [];
    /** Maps the call IDs handed to the agent back to Gemini's own function-call IDs (which may be absent). */
    private readonly geminiIds = new Map<string, string | undefined>();
    private turn = 0;

    constructor(client?: GeminiModelsClient) {
        this.client = client;
    }

    /** Read-only view of the conversation, for tests and audits. */
    get history(): readonly Content[] {
        return this.contents;
    }

    async next(ctx: AgentContext, last: ToolOutcome[]): Promise<PlannerDecision> {
        this.turn++;
        if (this.contents.length === 0) {
            this.contents.push({
                role: "user",
                parts: [
                    {
                        text:
                            `${ctx.inspection.task}\nInspection ID: ${ctx.inspection.id}.\n` +
                            `Current agent state: ${JSON.stringify(agentSnapshot(ctx))}`,
                    },
                ],
            });
        } else {
            if (last.length === 0) throw aiError(`${LABEL}: no tool results to report for the previous turn`, false);
            // One functionResponse per functionCall, same order, same name and (when Gemini supplied one) same id.
            const parts: Part[] = last.map((outcome) => {
                const geminiId = this.geminiIds.get(outcome.call.id);
                return {
                    functionResponse: {
                        ...(geminiId ? { id: geminiId } : {}),
                        name: outcome.call.name,
                        response: responsePayload(outcome, ctx),
                    },
                };
            });
            this.contents.push({ role: "user", parts });
        }

        this.client ??= createGeminiClient();
        const { response } = await callGemini(
            this.client,
            {
                model: env.GEMINI_PLANNER_MODEL,
                contents: this.contents,
                config: {
                    systemInstruction: AGENT_SYSTEM_PROMPT,
                    tools: [{ functionDeclarations: functionDeclarations() }],
                    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                },
            },
            { label: LABEL, deadlineMs: ctx.deadline },
        );
        assertUsableResponse(response, LABEL);

        const modelTurn = response.candidates?.[0]?.content;
        if (!modelTurn?.parts?.length) throw aiError(`${LABEL} returned an empty turn`, true);
        this.contents.push(modelTurn); // appended verbatim: thought signatures are preserved untouched

        const text = modelTurn.parts
            .filter((p) => typeof p.text === "string" && !p.thought)
            .map((p) => p.text)
            .join("\n")
            .trim();
        const calls = modelTurn.parts.flatMap((p) => (p.functionCall ? [p.functionCall] : []));
        if (calls.length === 0) return { type: "finish", text };

        return {
            type: "tool_calls",
            text,
            calls: calls.map((call, index) => {
                const id = call.id ?? `gemini-${this.turn}-${index}`;
                this.geminiIds.set(id, call.id);
                // An empty name is passed through so the registry rejects it as UNKNOWN_TOOL and the model sees why.
                return { id, name: call.name ?? "", args: call.args ?? {} };
            }),
        };
    }
}
