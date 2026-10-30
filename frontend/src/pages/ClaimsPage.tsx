import { useEffect, useState } from "react";
import { ClaimPanel } from "../components/ClaimPanel";
import { Badge, ErrorText, fmtDate, Section, useAction } from "../components/common";
import { api } from "../services/api";
import type { Claim, User } from "../types";

const STATUSES = ["", "draft", "pending_approval", "approved", "submitted", "rejected", "resolved"];

export const ClaimsPage = ({ user }: { user: User }) => {
    const [claims, setClaims] = useState<Claim[]>([]);
    const [status, setStatus] = useState("pending_approval");
    const [selected, setSelected] = useState<string | null>(null);
    const action = useAction();

    const load = () => action.run(async () => setClaims((await api.listClaims({ status })).claims));
    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    return (
        <div className="layout">
            <Section
                title={`Claims (${claims.length})`}
                actions={
                    <>
                        <select value={status} onChange={(e) => setStatus(e.target.value)}>
                            {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                    {s || "all statuses"}
                                </option>
                            ))}
                        </select>
                        <button onClick={load} disabled={action.busy}>
                            Refresh
                        </button>
                    </>
                }
            >
                <ErrorText error={action.error} />
                <table>
                    <thead>
                        <tr>
                            <th>Order</th>
                            <th>Status</th>
                            <th>Findings</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {claims.map((c) => (
                            <tr
                                key={c._id}
                                className={selected === c._id ? "selected" : ""}
                                onClick={() => setSelected(c._id)}
                            >
                                <td>
                                    {c.orderId} {c.analysisMode === "demo" && <Badge value="demo" />}
                                </td>
                                <td>
                                    <Badge value={c.status} />
                                </td>
                                <td>{c.findings.length}</td>
                                <td className="small">{fmtDate(c.updatedAt)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Section>
            <div>
                {selected ? (
                    <ClaimPanel claimId={selected} user={user} onChanged={load} />
                ) : (
                    <p className="muted card">Select a claim.</p>
                )}
            </div>
        </div>
    );
};
