import { useEffect, useState } from "react";
import { api } from "../services/api";
import type { Inspection } from "../types";
import { Badge, ErrorText, fmtDate, Section, useAction } from "./common";
import { InspectionResults } from "./InspectionResults";

const RUNNING = ["pending", "processing"];
const POLL_MS = 1500;

export const InspectionPanel = ({
    orderId,
    onChanged,
    onOpenClaim,
}: {
    orderId: string;
    onChanged: () => void;
    onOpenClaim: (claimId: string) => void;
}) => {
    const [history, setHistory] = useState<Inspection[]>([]);
    const [current, setCurrent] = useState<Inspection | null>(null);
    const action = useAction();

    const loadHistory = async () => {
        const { inspections } = await api.listInspections(orderId);
        setHistory(inspections);
        return inspections;
    };
    const open = async (id: string) => setCurrent((await api.getInspection(id)).inspection);

    useEffect(() => {
        setCurrent(null);
        void action.run(async () => {
            const list = await loadHistory();
            if (list[0]) await open(list[0]._id);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orderId]);

    // Poll while the backend job is running; the backend decides the outcome.
    useEffect(() => {
        if (!current || !RUNNING.includes(current.status)) return;
        const timer = setTimeout(async () => {
            try {
                const { inspection } = await api.getInspection(current._id);
                setCurrent(inspection);
                if (!RUNNING.includes(inspection.status)) {
                    await loadHistory();
                    onChanged();
                }
            } catch (e) {
                action.setError(e instanceof Error ? e.message : String(e));
            }
        }, POLL_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current]);

    const start = () =>
        action.run(async () => {
            const { inspection } = await api.startInspection(orderId);
            setCurrent(inspection);
            await loadHistory();
            onChanged();
        });

    const retry = () =>
        current &&
        action.run(async () => {
            const { inspection } = await api.retryInspection(current._id);
            setCurrent(inspection);
            await loadHistory();
            onChanged();
        });

    const running = current && RUNNING.includes(current.status);
    const canRetry = current && ["failed", "needs_review"].includes(current.status);

    return (
        <Section
            title="Inspection"
            actions={
                <>
                    <button className="primary" onClick={start} disabled={action.busy || Boolean(running)}>
                        {running ? "Inspecting…" : "Inspect Return"}
                    </button>
                    {canRetry && (
                        <button onClick={retry} disabled={action.busy}>
                            Retry inspection
                        </button>
                    )}
                    {current && (
                        <button onClick={() => action.run(() => open(current._id))} disabled={action.busy}>
                            Refresh
                        </button>
                    )}
                    {current?.claimId && <button onClick={() => onOpenClaim(current.claimId!)}>Open claim</button>}
                </>
            }
        >
            <ErrorText error={action.error} />
            {history.length > 1 && (
                <div className="row small">
                    History:
                    {history.map((h) => (
                        <button
                            key={h._id}
                            className={current?._id === h._id ? "active" : ""}
                            onClick={() => action.run(() => open(h._id))}
                        >
                            {fmtDate(h.createdAt)} <Badge value={h.status} />
                        </button>
                    ))}
                </div>
            )}
            {!current && (
                <p className="muted">
                    No inspection yet. Upload outbound and return videos, then click "Inspect Return".
                </p>
            )}
            {current && running && (
                <p className="banner info">
                    Running: {current.workflowState}… (refreshes every {POLL_MS / 1000}s)
                </p>
            )}
            {current && <InspectionResults inspection={current} />}
        </Section>
    );
};
