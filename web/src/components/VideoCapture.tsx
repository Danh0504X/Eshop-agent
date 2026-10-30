import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useCamera } from "../lib/camera";
import { IconUpload } from "./icons";
import { Alert, Button, Spinner } from "./ui";

export interface Capture {
    file: File;
    /** "recorded" = filmed in the app; "file" = an existing file chosen from the computer (demo). */
    captureMethod: "recorded" | "file";
    recordingStartedAt?: Date;
    recordingEndedAt?: Date;
    /** Known for recordings (from the clock); browser recordings often carry no duration header. */
    durationSec?: number;
}

/** Limits enforced by the backend (MIN_VIDEO_DURATION_SEC / MAX_VIDEO_DURATION_SEC). */
const MIN_SECONDS = 2;
const MAX_SECONDS = 600;
// VP8 first: some Chrome builds report VP9 as supported but record empty files. Safari records MP4.
const MIME_CANDIDATES = ["video/webm;codecs=vp8", "video/webm", "video/mp4"];
const RECORDING_FAILED =
    "Không ghi được video từ camera. Hãy thử quay lại; nếu vẫn lỗi, dùng Chrome hoặc Edge bản mới.";
const FILE_TYPES = "video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo";

const pickMimeType = () =>
    typeof MediaRecorder === "undefined" ? undefined : MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));

const pad = (n: number) => String(n).padStart(2, "0");
export const formatDuration = (sec: number) => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
export const formatSize = (bytes: number) =>
    bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : bytes >= 1024
          ? `${Math.round(bytes / 1024)} KB`
          : `${bytes} B`;
const fileStamp = (d: Date) =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

type Phase = "live" | "recording" | "review";

/**
 * Records an evidence video with the browser camera (MediaRecorder), or (demo) takes an existing video file.
 * The person reviews the result before `onCaptured` hands it over.
 */
export const VideoCapture = ({
    onCaptured,
    allowFile,
    busy,
    confirmLabel = "Dùng video này",
}: {
    onCaptured: (capture: Capture) => void;
    allowFile: boolean;
    busy?: boolean;
    confirmLabel?: string;
}) => {
    const [phase, setPhase] = useState<Phase>("live");
    const camera = useCamera(phase !== "review");
    const [result, setResult] = useState<Capture | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [problem, setProblem] = useState<string | null>(null);
    const recorder = useRef<MediaRecorder | null>(null);
    const chunks = useRef<Blob[]>([]);
    const startedAt = useRef<Date | null>(null);

    useEffect(
        () => () => {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        },
        [previewUrl],
    );

    // Stop a running recording when the component goes away, without producing a result.
    useEffect(
        () => () => {
            if (recorder.current?.state === "recording") {
                recorder.current.onstop = null;
                recorder.current.stop();
            }
        },
        [],
    );

    const stop = () => {
        if (recorder.current?.state === "recording") recorder.current.stop();
    };

    useEffect(() => {
        if (phase !== "recording") return;
        const timer = window.setInterval(() => {
            const sec = (Date.now() - (startedAt.current?.getTime() ?? Date.now())) / 1000;
            setElapsed(sec);
            if (sec >= MAX_SECONDS) stop();
        }, 250);
        return () => window.clearInterval(timer);
    }, [phase]);

    const review = (capture: Capture) => {
        setResult(capture);
        setPreviewUrl(URL.createObjectURL(capture.file));
        setPhase("review");
    };

    const start = () => {
        const mimeType = pickMimeType();
        if (!camera.stream || !mimeType) {
            setProblem("Trình duyệt này không hỗ trợ quay video. Hãy dùng Chrome, Edge hoặc Safari mới.");
            return;
        }
        chunks.current = [];
        const rec = new MediaRecorder(camera.stream, { mimeType, videoBitsPerSecond: 2_500_000 });
        rec.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.current.push(e.data);
        };
        rec.onerror = () => {
            rec.onstop = null;
            setProblem(RECORDING_FAILED);
            setPhase("live");
        };
        rec.onstop = () => {
            const began = startedAt.current ?? new Date();
            const ended = new Date();
            if (chunks.current.length === 0) {
                // Never hand over an empty recording.
                setProblem(RECORDING_FAILED);
                setPhase("live");
                return;
            }
            // The backend accepts the plain MIME type ("video/webm"), not one with codec parameters.
            const type = mimeType.split(";")[0];
            const file = new File(chunks.current, `quay-${fileStamp(began)}.${type === "video/mp4" ? "mp4" : "webm"}`, {
                type,
            });
            review({
                file,
                captureMethod: "recorded",
                recordingStartedAt: began,
                recordingEndedAt: ended,
                durationSec: (ended.getTime() - began.getTime()) / 1000,
            });
        };
        startedAt.current = new Date();
        setElapsed(0);
        setProblem(null);
        rec.start(1000);
        recorder.current = rec;
        setPhase("recording");
    };

    const chooseFile = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) review({ file, captureMethod: "file" });
    };

    const discard = () => {
        setResult(null);
        setPreviewUrl(null);
        setProblem(null);
        setPhase("live");
    };

    const tooShort = result?.durationSec !== undefined && result.durationSec < MIN_SECONDS;

    return (
        <div className="capture">
            <div className="camera-frame camera-frame-wide">
                {phase === "review" && previewUrl ? (
                    <video
                        key={previewUrl}
                        src={previewUrl}
                        className="camera-video review-video"
                        controls
                        playsInline
                    />
                ) : (
                    <>
                        <video ref={camera.videoRef} className="camera-video" muted playsInline autoPlay />
                        {phase === "recording" && (
                            <div className="rec-badge">
                                <span className="rec-dot" />
                                {formatDuration(elapsed)}
                            </div>
                        )}
                        {camera.status === "starting" && (
                            <div className="camera-overlay">
                                <Spinner />
                                <p>Đang mở camera…</p>
                            </div>
                        )}
                        {camera.status === "error" && (
                            <div className="camera-overlay">
                                <p>{camera.error}</p>
                                <Button size="sm" onClick={camera.retry}>
                                    Thử lại
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </div>

            {problem && <Alert tone="warn">{problem}</Alert>}
            {tooShort && <Alert tone="warn">Video quá ngắn (dưới {MIN_SECONDS} giây). Hãy quay lại.</Alert>}
            {phase === "review" && result && (
                <p className="capture-meta">
                    {result.captureMethod === "recorded" ? "Quay trong app" : `File từ máy · ${result.file.name}`}
                    {result.durationSec !== undefined && ` · ${formatDuration(result.durationSec)}`} ·{" "}
                    {formatSize(result.file.size)}
                </p>
            )}

            <div className="capture-actions">
                {phase === "live" && (
                    <Button
                        variant="primary"
                        size="lg"
                        icon={<span className="rec-dot rec-dot-idle" />}
                        onClick={start}
                        disabled={camera.status !== "live"}
                    >
                        Bắt đầu quay
                    </Button>
                )}
                {phase === "recording" && (
                    <Button variant="danger" size="lg" icon={<span className="stop-square" />} onClick={stop}>
                        Dừng quay
                    </Button>
                )}
                {phase === "review" && result && (
                    <>
                        <Button size="lg" onClick={discard} disabled={busy}>
                            {result.captureMethod === "recorded" ? "Quay lại" : "Chọn video khác"}
                        </Button>
                        <Button
                            variant="primary"
                            size="lg"
                            busy={busy}
                            disabled={tooShort}
                            onClick={() => onCaptured(result)}
                        >
                            {confirmLabel}
                        </Button>
                    </>
                )}
                {phase === "live" && allowFile && (
                    <label className="btn btn-secondary btn-lg">
                        <IconUpload size={18} />
                        Chọn video từ máy (demo)
                        <input type="file" accept={FILE_TYPES} className="visually-hidden" onChange={chooseFile} />
                    </label>
                )}
            </div>
        </div>
    );
};
