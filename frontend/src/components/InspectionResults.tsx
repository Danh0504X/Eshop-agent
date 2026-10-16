import type { AnalysisRecord, Inspection, Validation } from "../types";
import { AuthImage, Badge, fmtDate } from "./common";

const ModeNotice = ({ inspection }: { inspection: Inspection }) =>
    inspection.analysisMode === "demo" ? (
        <p className="banner demo">
            DEMO MODE: these results come from predefined demo data, not from real AI analysis.
        </p>
    ) : null;

const ValidationTable = ({ title, v }: { title: string; v?: Validation | null }) =>
    v ? (
        <details>
            <summary>
                {title}: {v.ok ? "OK" : "issues found"} {v.blocking && <Badge value="blocking" />}
            </summary>
            <table>
                <tbody>
                    {v.checks.map((c, i) => (
                        <tr key={i}>
                            <td>
                                <Badge value={c.status} />
                            </td>
                            <td>{c.name}</td>
                            <td>{c.evidenceType ?? ""}</td>
                            <td className="small">{c.detail}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </details>
    ) : null;

const AnalysisSummary = ({ title, record }: { title: string; record?: AnalysisRecord }) => {
    if (!record) return null;
    const r = record.result as Record<string, any>;
    const item = r.items?.[0];
    const obs = (o?: { value: unknown; status: string }) => (o ? `${o.value ?? "-"} (${o.status})` : "-");
    return (
        <div className="analysis">
            <h4>
                {title} <Badge value={record.source === "demo" ? "demo data" : `AI: ${record.model}`} />
            </h4>
            <table>
                <tbody>
                    <tr>
                        <td>Package contents</td>
                        <td>{r.packageContents}</td>
                    </tr>
                    <tr>
                        <td>Product type</td>
                        <td>{obs(item?.productType)}</td>
                    </tr>
                    <tr>
                        <td>Quantity</td>
                        <td>{obs(r.totalItemCount)}</td>
                    </tr>
                    <tr>
                        <td>Colour</td>
                        <td>{obs(item?.color)}</td>
                    </tr>
                    <tr>
                        <td>Model</td>
                        <td>{obs(item?.model)}</td>
                    </tr>
                    <tr>
                        <td>Accessories</td>
                        <td>{(r.accessories ?? []).map((a: any) => `${a.name}: ${a.status}`).join(", ") || "-"}</td>
                    </tr>
                    <tr>
                        <td>Packaging</td>
                        <td>{r.packagingCondition?.overall}</td>
                    </tr>
                    <tr>
                        <td>Image conditions</td>
                        <td>
                            {r.imageConditions
                                ? `${r.imageConditions.lighting} light, ${r.imageConditions.focus}, ${r.imageConditions.continuity}`
                                : "-"}
                        </td>
                    </tr>
                    <tr>
                        <td>Model confidence</td>
                        <td>{r.overallConfidence?.toFixed(2)} (not calibrated)</td>
                    </tr>
                </tbody>
            </table>
            {r.uncertaintyNotes?.length > 0 && (
                <ul className="small">
                    {r.uncertaintyNotes.map((n: string, i: number) => (
                        <li key={i}>{n}</li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export const InspectionResults = ({ inspection }: { inspection: Inspection }) => {
    const findings = inspection.comparison?.findings ?? [];
    const frameUrl = new Map(inspection.frameReferences.map((f) => [f.frameId, f.imageUrl]));

    return (
        <div className="stack">
            <ModeNotice inspection={inspection} />
            <div className="row">
                <Badge value={inspection.status} />
                <span>state: {inspection.workflowState}</span>
                <span className="muted small">
                    attempt {inspection.attempt} · planner {inspection.planner}
                    {inspection.plannerFallback && " (fell back to deterministic)"} · finished{" "}
                    {fmtDate(inspection.finishedAt)}
                </span>
            </div>
            {inspection.error && <p className="error">Error: {inspection.error}</p>}
            {inspection.summary && <p>{inspection.summary}</p>}
            {inspection.recommendedAction && (
                <p className="banner next">
                    <b>Recommended next action:</b> {inspection.recommendedAction}
                </p>
            )}

            {inspection.reviewTask?.status && (
                <div className={`banner ${inspection.reviewTask.status === "open" ? "warn" : "muted"}`}>
                    <b>Human review: {inspection.reviewTask.status}</b>
                    <ul className="small">
                        {(inspection.reviewTask.reasons ?? []).map((r, i) => (
                            <li key={i}>{r}</li>
                        ))}
                    </ul>
                    {inspection.reviewTask.requiredAction && (
                        <div>Required: {inspection.reviewTask.requiredAction}</div>
                    )}
                    {inspection.reviewTask.resolutionNote && (
                        <div className="muted">{inspection.reviewTask.resolutionNote}</div>
                    )}
                </div>
            )}

            {inspection.confidence && (
                <p className="small">
                    Confidence {inspection.confidence.score?.toFixed(2)} vs threshold {inspection.confidence.threshold}{" "}
                    ({inspection.confidence.meetsThreshold ? "meets" : "below"}; model-reported, not a calibrated
                    probability)
                </p>
            )}

            <h4>Findings ({findings.length})</h4>
            {inspection.comparison && <p className="muted small">{inspection.comparison.disclaimer}</p>}
            {findings.length > 0 && (
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Severity</th>
                            <th>Conf.</th>
                            <th>Description</th>
                            <th>Evidence</th>
                        </tr>
                    </thead>
                    <tbody>
                        {findings.map((f) => (
                            <tr key={f.id}>
                                <td>{f.id}</td>
                                <td>
                                    <Badge value={f.severity} />
                                    <div className="muted small">{f.certainty}</div>
                                </td>
                                <td>{f.confidence.toFixed(2)}</td>
                                <td>
                                    {f.description}
                                    <div className="muted small">
                                        outbound: {f.outboundObservation ?? "-"} | return: {f.returnObservation ?? "-"}
                                    </div>
                                </td>
                                <td className="small">
                                    {f.evidence
                                        .map((e) => `${e.frameId} @${e.timestampSec?.toFixed(1) ?? "?"}s`)
                                        .join(", ") || "-"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {inspection.frameReferences.length > 0 && (
                <details>
                    <summary>Supporting frames ({inspection.frameReferences.length})</summary>
                    <div className="frames">
                        {inspection.frameReferences.map((f) =>
                            f.imageUrl ? (
                                <figure key={f.frameId}>
                                    <AuthImage src={frameUrl.get(f.frameId)!} alt={f.frameId} />
                                    <figcaption>
                                        {f.frameId} ({f.type}) @ {f.timestampSec?.toFixed(1)}s
                                    </figcaption>
                                </figure>
                            ) : null,
                        )}
                    </div>
                </details>
            )}

            <ValidationTable title="Initial evidence validation" v={inspection.evidenceValidation?.initial} />
            <ValidationTable title="Final verification" v={inspection.evidenceValidation?.final} />

            <div className="two-col">
                <AnalysisSummary title="Outbound analysis" record={inspection.outboundAnalysis} />
                <AnalysisSummary title="Return analysis" record={inspection.returnAnalysis} />
            </div>

            {inspection.agentNarrative && (
                <details>
                    <summary>Agent narrative (LLM text, informational only)</summary>
                    <p className="pre">{inspection.agentNarrative}</p>
                </details>
            )}

            <details>
                <summary>Workflow progress and agent log ({inspection.agentLog.length})</summary>
                <ol className="small">
                    {inspection.stateHistory.map((s, i) => (
                        <li key={i}>
                            {s.state} {s.note && `- ${s.note}`} <span className="muted">(attempt {s.attempt})</span>
                        </li>
                    ))}
                </ol>
                <table className="small">
                    <tbody>
                        {inspection.agentLog.map((l, i) => (
                            <tr key={i}>
                                <td>{l.attempt}</td>
                                <td>{l.kind}</td>
                                <td>{l.tool ?? l.state ?? ""}</td>
                                <td>{l.error ? <span className="error">{l.error}</span> : l.message}</td>
                                <td>{l.durationMs !== undefined ? `${l.durationMs} ms` : ""}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>
        </div>
    );
};
