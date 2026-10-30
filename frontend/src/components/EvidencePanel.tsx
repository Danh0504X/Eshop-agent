import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../services/api";
import type { Media, User } from "../types";
import { AuthVideo, Badge, ErrorText, fmtBytes, fmtDate, Section, useAction } from "./common";

const MediaRow = ({ media, user, onChanged }: { media: Media; user: User; onChanged: () => void }) => {
    const del = useAction();
    const remove = () => {
        const reason = prompt("Deleting evidence is permanent. Reason (min 5 characters):");
        if (!reason) return;
        void del.run(async () => {
            await api.deleteMedia(media._id, reason);
            onChanged();
        });
    };
    const q = media.quality;
    return (
        <div className="media">
            <div className="row">
                <b>{media.type === "outbound" ? "Outbound (packing)" : "Return (opening)"}</b>
                <Badge value={media.status} />
                <span className="muted small">
                    {media.originalName} · {fmtBytes(media.sizeBytes)} · {fmtDate(media.uploadedAt)}
                </span>
            </div>
            <div className="small">
                {media.metadata?.durationSec !== undefined && (
                    <span>
                        {media.metadata.durationSec.toFixed(1)} s · {media.metadata.width}×{media.metadata.height}{" "}
                        ·{" "}
                    </span>
                )}
                {media.frames.length} frames
                {q?.darkFrameRatio !== undefined &&
                    ` · dark ${(q.darkFrameRatio * 100).toFixed(0)}% · blurry ${((q.blurryFrameRatio ?? 0) * 100).toFixed(0)}% · ${q.continuous ? "continuous" : "possible gap"}`}
                {media.processingError && <span className="error"> · {media.processingError}</span>}
            </div>
            <div className="small muted">
                {media.capture
                    ? `Label ${media.capture.manualEntry ? "typed by hand" : `scanned (${media.capture.scanMethod})`} · ${
                          media.capture.captureMethod === "recorded" ? "recorded in the app" : "attached file"
                      }`
                    : "Not uploaded through a label scan"}
            </div>
            <div className="row">
                <AuthVideo src={media.fileUrl} />
                {user.role === "owner" && (
                    <button className="danger" onClick={remove} disabled={del.busy}>
                        Delete evidence
                    </button>
                )}
            </div>
            <ErrorText error={del.error} />
        </div>
    );
};

export const EvidencePanel = ({ orderId, user, onChanged }: { orderId: string; user: User; onChanged: () => void }) => {
    const [media, setMedia] = useState<Media[]>([]);
    const [type, setType] = useState<"outbound" | "return">("outbound");
    const [code, setCode] = useState("");
    const [replace, setReplace] = useState(false);
    const [reason, setReason] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);
    const load = useAction();
    const upload = useAction();

    const refresh = () => load.run(async () => setMedia((await api.listMedia(orderId)).media));
    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orderId]);

    const hasType = media.some((m) => m.type === type);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const file = fileRef.current?.files?.[0];
        if (!file) return upload.setError("Choose a video file first");
        if (!code.trim()) return upload.setError("Enter the tracking code printed on the label");
        void upload.run(async () => {
            // Every video is bound to a scan of the order's label; this UI records the typed code as a manual scan.
            const { scan } = await api.scan(code.trim(), type === "outbound" ? "packing" : "return");
            const form = new FormData();
            form.append("type", type);
            form.append("scanId", scan.id);
            form.append("captureMethod", "file");
            if (replace) {
                form.append("replaceExisting", "true");
                form.append("replacementReason", reason);
            }
            form.append("file", file);
            await api.uploadMedia(orderId, form);
            if (fileRef.current) fileRef.current.value = "";
            setCode("");
            setReplace(false);
            setReason("");
            await refresh();
            onChanged();
        });
    };

    return (
        <Section
            title="Evidence"
            actions={
                <button onClick={refresh} disabled={load.busy}>
                    Refresh
                </button>
            }
        >
            {media.length === 0 && <p className="muted">No evidence uploaded.</p>}
            {media.map((m) => (
                <MediaRow
                    key={m._id}
                    media={m}
                    user={user}
                    onChanged={() => {
                        void refresh();
                        onChanged();
                    }}
                />
            ))}
            <ErrorText error={load.error} />

            <form className="upload" onSubmit={submit}>
                <select value={type} onChange={(e) => setType(e.target.value as "outbound" | "return")}>
                    <option value="outbound">Outbound packing video</option>
                    <option value="return">Return opening video</option>
                </select>
                <input
                    placeholder="Tracking code on the label *"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                />
                <input
                    ref={fileRef}
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo"
                />
                {hasType && (
                    <label className="row small">
                        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                        Replace existing {type} evidence (kept as superseded)
                    </label>
                )}
                {replace && (
                    <input
                        placeholder="Replacement reason (required)"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    />
                )}
                <button type="submit" className="primary" disabled={upload.busy}>
                    {upload.busy ? "Uploading…" : "Upload video"}
                </button>
            </form>
            <ErrorText error={upload.error} />
        </Section>
    );
};
