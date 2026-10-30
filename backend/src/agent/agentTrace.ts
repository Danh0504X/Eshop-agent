import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env";
import type { ToolResult } from "./tools/types";

/**
 * Human-readable, line-by-line trace of an inspection, printed to the server console for demos and debugging:
 * planner decisions, tool results, Gemini calls and the final outcome. It is a view only; the authoritative
 * record stays in inspection.agentLog and the audit log. Disable with AGENT_TRACE=false.
 */

interface TraceContext {
    orderId: string;
    startedAt: number;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Run `fn` with a trace context so nested code (tools, Gemini calls) can label its lines with the order. */
export const withTraceContext = <T>(orderId: string, fn: () => Promise<T>): Promise<T> =>
    storage.run({ orderId, startedAt: Date.now() }, fn);

type Sink = (line: string) => void;
let sink: Sink | undefined;

/** Test hook: capture trace lines instead of printing them (undefined restores console output). */
export const setTraceSink = (next: Sink | undefined): void => {
    sink = next;
};

const enabled = () => Boolean(sink) || (env.AGENT_TRACE && env.NODE_ENV !== "test");

const elapsed = (ctx?: TraceContext) => (ctx ? `+${((Date.now() - ctx.startedAt) / 1000).toFixed(1)}s` : "");

/** Print one trace line (and optional indented detail lines). */
export const trace = (message: string, details: string[] = []): void => {
    if (!enabled()) return;
    const ctx = storage.getStore();
    const prefix = `[FixIt ${ctx?.orderId ?? "-"} ${elapsed(ctx)}]`;
    const write = sink ?? ((line: string) => process.stdout.write(`${line}\n`));
    write(`${prefix} ${message}`);
    for (const line of details) write(`${" ".repeat(prefix.length + 1)}${line}`);
};

// --- Tool result summaries -------------------------------------------------------------------------------------

type Data = Record<string, any>;

const obs = (o: { value?: unknown; status?: string } | undefined) =>
    o ? `${o.value ?? "-"} (${o.status ?? "?"})` : "-";

const pct = (n: unknown) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "?");

const reasonLines = (reasons: Array<{ code: string; message: string; blocking: boolean }> = []) =>
    reasons.map((r) => `${r.blocking ? "BLOCKING" : "advisory"} ${r.code}: ${r.message}`);

const describeCondition = (condition: Data | undefined): string => {
    if (!condition) return "-";
    if (condition.status === "not_visible") return "surface not visible";
    const damage: Data[] = condition.damage ?? [];
    if (!damage.length) return `no visible damage (${condition.status})`;
    return damage.map((d) => `${d.kind} ${d.severity} [${d.certainty}] (${(d.frameIds ?? []).join(",")})`).join("; ");
};

/** One-line headline plus detail lines describing what a tool found, per tool. */
export const summarizeToolResult = (tool: string, data: Data): { headline: string; details: string[] } => {
    switch (tool) {
        case "lookup_order":
            return {
                headline: `order found: ${data.product?.name ?? "?"}${data.product?.model ? ` ${data.product.model}` : ""}${data.product?.color ? ` ${data.product.color}` : ""}, qty ${data.expectedQuantity}`,
                details: [
                    `accessories: ${(data.expectedAccessories ?? []).join(", ") || "none"}`,
                    `evidence linked: outbound=${data.outboundEvidenceLinked ? "yes" : "NO"} return=${data.returnEvidenceLinked ? "yes" : "NO"}`,
                ],
            };
        case "validate_evidence":
            return {
                headline: `${data.stage} validation: ${data.ok ? "OK" : "issues found"}${data.blocking ? " (BLOCKING)" : ""}`,
                details: [
                    ...reasonLines(data.escalationReasons),
                    ...(data.missing?.length ? [`missing: ${data.missing.join(", ")}`] : []),
                    ...(data.nextStep ? [`next: ${data.nextStep}`] : []),
                ],
            };
        case "extract_frames": {
            const q = data.quality ?? {};
            const frames: Data[] = data.frames ?? [];
            return {
                headline: `${data.type} video: ${frames.length} frames from ${Number(data.durationSec ?? 0).toFixed(1)} s${data.cached ? " (cached)" : ""}`,
                details: [
                    `quality: dark ${pct(q.darkFrameRatio)}, blurry ${pct(q.blurryFrameRatio)}, max gap ${Number(q.maxTimestampGapSec ?? 0).toFixed(2)} s, ${q.continuous ? "continuous" : "POSSIBLE CUT"}`,
                    `frames: ${frames.map((f) => `${f.frameId}@${Number(f.timestampSec).toFixed(1)}s${f.quality !== "ok" ? `[${f.quality}]` : ""}`).join(" ")}`,
                    ...(data.qualityIssues?.length ? reasonLines(data.qualityIssues) : []),
                ],
            };
        }
        case "analyze_item": {
            const item = data.items?.[0];
            return {
                headline: `${data.evidenceType} ${data.reanalysis ? `RE-ANALYSIS with ${data.segmentFramesIncluded?.length ?? 0} segment frame(s)` : "analysis"} (${data.source === "demo" ? "DEMO DATA" : data.reused ? "AI, REUSED from an earlier run, no AI call" : "AI"}): contents=${data.packageContents}, confidence ${Number(data.overallConfidence ?? 0).toFixed(2)}`,
                details: [
                    `frames sent: ${(data.framesAnalyzed ?? []).length} of ${data.framesExtracted ?? "?"} extracted (dark or blurry frames are left out)`,
                    `product ${obs(item?.productType)} | qty ${obs(data.totalItemCount)} | colour ${obs(item?.color)} | model ${obs(item?.model)}`,
                    `product condition: ${describeCondition(item?.condition)}`,
                    `accessories: ${(data.accessories ?? []).map((a: Data) => `${a.name}=${a.status}`).join(", ") || "none listed"} | packaging: ${data.packagingCondition?.overall ?? "?"}`,
                    `image: ${data.imageConditions?.lighting} light, ${data.imageConditions?.focus}, ${data.imageConditions?.continuity}`,
                    ...(data.instructionLikeTextFound
                        ? [
                              `WARNING: ${data.instructionLikeTextFound} instruction-like text(s) found in footage (ignored)`,
                          ]
                        : []),
                    ...(data.validationNotes ?? []).slice(0, 3).map((n: string) => `note: ${n}`),
                ],
            };
        }
        case "compare_items": {
            const findings: Data[] = data.findings ?? [];
            return {
                headline: `comparison: ${data.materialDiscrepancyCount} material discrepancy(ies), max severity ${data.maxSeverity}, confidence ${Number(data.overallConfidence ?? 0).toFixed(2)}${data.meetsThreshold ? "" : " (BELOW THRESHOLD)"}`,
                details: [
                    ...findings.map(
                        (f) =>
                            `${f.id} ${String(f.severity).toUpperCase()} ${f.category} [${f.certainty}]: ${f.description}` +
                            (f.evidence?.length
                                ? ` (${f.evidence.map((e: Data) => `${e.frameId}@${e.timestampSec?.toFixed?.(1) ?? "?"}s`).join(", ")})`
                                : ""),
                    ),
                    ...(data.unverifiedAttributes?.length
                        ? [`not verifiable: ${data.unverifiedAttributes.join(", ")}`]
                        : []),
                ],
            };
        }
        case "inspect_video_segment": {
            const budget = data.budgetRemaining ?? {};
            return {
                headline: `segment ${data.segmentId} of ${data.evidenceType} ${data.startSec}-${data.endSec}s (${data.source === "demo" ? "DEMO DATA" : "AI"}): ${String(data.verdict).toUpperCase()}, confidence ${Number(data.overallConfidence ?? 0).toFixed(2)}`,
                details: [
                    `question: ${data.question}`,
                    `answer: ${data.answer}`,
                    ...(data.observations ?? []).map(
                        (o: Data) => `observed [${o.certainty}]: ${o.description} (${(o.frameIds ?? []).join(", ")})`,
                    ),
                    `budget left: ${budget.segmentInspections ?? "?"} segment(s), ${budget.aiRequests ?? "?"} AI request(s), ${budget.framesAnalyzed ?? "?"} frame(s)`,
                    ...(data.instructionLikeTextFound
                        ? [
                              `WARNING: ${data.instructionLikeTextFound} instruction-like text(s) found in footage (ignored)`,
                          ]
                        : []),
                ],
            };
        }
        case "build_claim_pack":
            return {
                headline: `draft claim ${data.claimId} created (${data.status}), ${data.findings} finding(s), PDF ${data.reportGenerated ? "generated" : "MISSING"}`,
                details: [],
            };
        case "notify_human":
            return {
                headline: `human review requested: ${(data.reasons ?? []).join(", ") || "agent request"}`,
                details: data.requiredAction ? [`required action: ${data.requiredAction}`] : [],
            };
        default:
            return { headline: `${tool} done`, details: [] };
    }
};

export const traceToolResult = (
    tool: string,
    args: unknown,
    result: ToolResult,
    durationMs: number,
    planner?: string,
): void => {
    if (!enabled()) return;
    const argText = args && typeof args === "object" && Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
    const timing = `${(durationMs / 1000).toFixed(1)}s`;
    if (!result.ok) {
        trace(
            `  FAIL ${tool}${argText} (${timing}, by ${planner ?? "?"}): ${result.error.code} - ${result.error.message}`,
            [result.error.retryable ? "retryable" : "not retryable"],
        );
        return;
    }
    const { headline, details } = summarizeToolResult(tool, result.data);
    trace(`  OK   ${tool}${argText} (${timing}): ${headline}`, details);
};
