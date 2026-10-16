import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchObjectUrl } from "../services/api";

/** Wraps an async action with busy and error state, so every button shows progress and failures. */
export const useAction = () => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
        setBusy(true);
        setError(null);
        try {
            return await fn();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            return undefined;
        } finally {
            setBusy(false);
        }
    }, []);
    return { busy, error, run, setError };
};

export const ErrorText = ({ error }: { error: string | null }) => (error ? <p className="error">{error}</p> : null);

const STATUS_CLASS: Record<string, string> = {
    completed: "ok",
    approved: "ok",
    resolved: "ok",
    submitted: "ok",
    pass: "ok",
    needs_review: "warn",
    pending_approval: "warn",
    draft: "warn",
    warn: "warn",
    pending: "info",
    processing: "info",
    failed: "bad",
    rejected: "bad",
    fail: "bad",
    critical: "bad",
    high: "bad",
    medium: "warn",
    low: "info",
    info: "muted",
};

export const Badge = ({ value }: { value: string | undefined | null }) => (
    <span className={`badge ${STATUS_CLASS[value ?? ""] ?? "muted"}`}>{value ?? "-"}</span>
);

export const Section = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => (
    <section className="card">
        <div className="card-head">
            <h3>{title}</h3>
            <div className="row">{actions}</div>
        </div>
        {children}
    </section>
);

/** Protected image (frames): fetched with the auth header, shown on demand. */
export const AuthImage = ({ src, alt }: { src: string; alt: string }) => {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let objectUrl: string | null = null;
        fetchObjectUrl(src)
            .then((u) => setUrl((objectUrl = u)))
            .catch(() => setFailed(true));
        return () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [src]);
    if (failed) return <span className="muted">[{alt} unavailable]</span>;
    return url ? <img className="frame" src={url} alt={alt} /> : <span className="muted">loading…</span>;
};

/** Protected video: only downloaded when the user asks to view it. */
export const AuthVideo = ({ src }: { src: string }) => {
    const [url, setUrl] = useState<string | null>(null);
    const action = useAction();
    useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
    if (url) return <video className="video" src={url} controls />;
    return (
        <>
            <button disabled={action.busy} onClick={() => action.run(async () => setUrl(await fetchObjectUrl(src)))}>
                {action.busy ? "Loading…" : "View video"}
            </button>
            <ErrorText error={action.error} />
        </>
    );
};

export const fmtDate = (value?: string) => (value ? new Date(value).toLocaleString() : "-");
export const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`);
