import { useEffect, useState } from "react";
import { api, downloadFile } from "../services/api";
import type { Claim, User } from "../types";
import { Badge, ErrorText, fmtDate, Section, useAction } from "./common";

const DETERMINATIONS = ["", "no_determination", "discrepancy_confirmed_by_reviewer", "no_discrepancy", "inconclusive"];

export const ClaimPanel = ({ claimId, user, onChanged }: { claimId: string; user: User; onChanged?: () => void }) => {
    const [claim, setClaim] = useState<Claim | null>(null);
    const [reason, setReason] = useState("");
    const [determination, setDetermination] = useState("");
    const [reference, setReference] = useState("");
    const action = useAction();

    const load = () => action.run(async () => setClaim((await api.getClaim(claimId)).claim));
    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [claimId]);

    const act = (fn: () => Promise<{ claim: Claim }>) =>
        action.run(async () => {
            setClaim((await fn()).claim);
            setReason("");
            onChanged?.();
        });

    if (!claim) return <Section title="Claim">{action.busy ? "Loading…" : <ErrorText error={action.error} />}</Section>;

    const owner = user.role === "owner";
    const s = claim.status;
    return (
        <Section
            title={`Claim for ${claim.orderId}`}
            actions={
                <>
                    <Badge value={s} />
                    {claim.reportUrl && (
                        <button
                            onClick={() =>
                                action.run(() => downloadFile(claim.reportUrl!, `claim-${claim.orderId}.pdf`))
                            }
                        >
                            Download PDF report
                        </button>
                    )}
                    <button onClick={load} disabled={action.busy}>
                        Refresh
                    </button>
                </>
            }
        >
            <p className="banner warn">
                AI-generated draft, pending human review. Findings are visual discrepancies, not proof of wrongdoing.
                {claim.analysisMode === "demo" && " DEMO MODE: based on predefined demo data, not real AI analysis."}
            </p>
            <p>{claim.summary}</p>
            <ul className="small">
                {claim.findings.map((f) => (
                    <li key={f.id}>
                        <Badge value={f.severity} /> {f.description}{" "}
                        <span className="muted">
                            ({f.evidence.map((e) => `${e.frameId} @${e.timestampSec?.toFixed(1)}s`).join(", ")})
                        </span>
                    </li>
                ))}
            </ul>
            {claim.redaction && (
                <p className="small muted">
                    Privacy: {claim.redaction.textRedactions ?? 0} text redaction(s),{" "}
                    {claim.redaction.framesBlurred ?? 0} blurred frame(s).{" "}
                    {claim.redaction.fullyAnonymized
                        ? ""
                        : "Not fully anonymized - privacy review required before sharing."}
                </p>
            )}
            {claim.approval?.decision && (
                <p className="small">
                    Decision: <b>{claim.approval.decision}</b> - {claim.approval.reason} (
                    {fmtDate(claim.approval.decidedAt)}
                    {claim.approval.finalDetermination && `, determination: ${claim.approval.finalDetermination}`})
                </p>
            )}

            <h4>Review decision {!owner && <span className="muted small">(owner only)</span>}</h4>
            <div className="row">
                <input
                    placeholder="Reason (required, min 5 characters)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                />
                {["draft", "pending_approval"].includes(s) && (
                    <>
                        <select value={determination} onChange={(e) => setDetermination(e.target.value)}>
                            {DETERMINATIONS.map((d) => (
                                <option key={d} value={d}>
                                    {d || "final determination (optional)"}
                                </option>
                            ))}
                        </select>
                        <button
                            className="primary"
                            disabled={!owner || action.busy}
                            onClick={() => act(() => api.approveClaim(claim._id, reason, determination || undefined))}
                        >
                            Approve
                        </button>
                        <button
                            className="danger"
                            disabled={!owner || action.busy}
                            onClick={() => act(() => api.rejectClaim(claim._id, reason))}
                        >
                            Reject
                        </button>
                    </>
                )}
                {["approved", "submitted"].includes(s) && (
                    <button
                        disabled={!owner || action.busy}
                        onClick={() => act(() => api.resolveClaim(claim._id, reason))}
                    >
                        Resolve
                    </button>
                )}
            </div>
            {s === "approved" && (
                <div className="row">
                    <input
                        placeholder="External reference (e.g. marketplace case ID)"
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                    />
                    <button
                        disabled={!owner || action.busy}
                        onClick={() =>
                            act(() => api.markSubmitted(claim._id, reference || undefined, reason || undefined))
                        }
                    >
                        Record manual submission
                    </button>
                    <span className="muted small">FixIt never submits claims externally.</span>
                </div>
            )}
            <ErrorText error={action.error} />

            <details>
                <summary>History ({claim.history.length})</summary>
                <ol className="small">
                    {claim.history.map((h, i) => (
                        <li key={i}>
                            {fmtDate(h.at)}: {h.from ?? "-"} → {h.to} by {h.by} {h.reason && `- ${h.reason}`}
                        </li>
                    ))}
                </ol>
            </details>
        </Section>
    );
};
