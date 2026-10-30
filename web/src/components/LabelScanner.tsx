import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { detectCodes, TRACKING_CODE, type DetectedCode } from "../lib/barcode";
import { useCamera } from "../lib/camera";
import { IconUpload } from "./icons";
import { Alert, Button, Spinner } from "./ui";

/** How the tracking code reached the app; sent to the backend with the scan. */
export type ScanMethod = "camera" | "image_file" | "manual";

/** A camera read is accepted only after the same code shows up in this many consecutive frames. */
const STABLE_READS = 2;
const SCAN_INTERVAL_MS = 250;
const NOT_A_TRACKING_CODE =
    "Đã đọc được một mã nhưng đó không phải mã vận đơn (ví dụ mã QR chứa đường link). Hãy đưa mã vạch vận đơn vào khung.";
const NO_CODE_IN_IMAGE = "Không tìm thấy mã vạch trong ảnh. Hãy chọn ảnh chụp rõ nét, thẳng nhãn vận đơn.";

const validValues = (codes: DetectedCode[]) => codes.filter((c) => c.valid).map((c) => c.value);

/**
 * Reads the tracking code from a shipping label with the camera, or (demo) from an uploaded photo of the label.
 * A person can type the code when the label is damaged; such codes are marked as manual entries by the backend.
 * Calls `onDetected` once; remount (change `key`) to scan again.
 */
export const LabelScanner = ({
    onDetected,
    allowImage,
}: {
    onDetected: (code: string, method: ScanMethod) => void;
    allowImage: boolean;
}) => {
    const [mode, setMode] = useState<"camera" | "manual">("camera");
    const camera = useCamera(mode === "camera");
    const [hint, setHint] = useState<string | null>(null);
    const [choices, setChoices] = useState<{ codes: string[]; method: ScanMethod } | null>(null);
    const [readingImage, setReadingImage] = useState(false);
    const [typed, setTyped] = useState("");
    const done = useRef(false);
    const lastRead = useRef<{ value: string; count: number } | null>(null);

    const accept = useCallback(
        (code: string, method: ScanMethod) => {
            if (done.current) return;
            done.current = true;
            onDetected(code, method);
        },
        [onDetected],
    );

    // Decode camera frames a few times per second while the camera is live and no choice is pending.
    useEffect(() => {
        if (mode !== "camera" || camera.status !== "live" || choices) return;
        let stopped = false;
        let timer: number | undefined;
        const tick = async () => {
            const video = camera.videoRef.current;
            if (video && video.readyState >= 2 && !done.current) {
                try {
                    const codes = await detectCodes(video);
                    const valid = validValues(codes);
                    if (valid.length > 1) {
                        // Labels often carry several barcodes; let the person pick the tracking number.
                        setChoices({ codes: valid, method: "camera" });
                        return;
                    }
                    if (valid.length === 1) {
                        const count = lastRead.current?.value === valid[0] ? lastRead.current.count + 1 : 1;
                        lastRead.current = { value: valid[0], count };
                        if (count >= STABLE_READS) return accept(valid[0], "camera");
                    } else {
                        lastRead.current = null;
                    }
                    setHint(codes.length ? NOT_A_TRACKING_CODE : null);
                } catch {
                    // The decoder is still loading or the frame was not ready; try the next one.
                }
            }
            if (!stopped && !done.current) timer = window.setTimeout(tick, SCAN_INTERVAL_MS);
        };
        void tick();
        return () => {
            stopped = true;
            window.clearTimeout(timer);
        };
    }, [mode, camera.status, camera.videoRef, choices, accept]);

    const readImage = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ""; // choosing the same file again must trigger another read
        if (!file) return;
        setReadingImage(true);
        setHint(null);
        try {
            const codes = await detectCodes(file);
            const valid = validValues(codes);
            if (valid.length === 1) accept(valid[0], "image_file");
            else if (valid.length > 1) setChoices({ codes: valid, method: "image_file" });
            else setHint(codes.length ? NOT_A_TRACKING_CODE : NO_CODE_IN_IMAGE);
        } catch {
            setHint("Không đọc được ảnh này. Hãy chọn một file ảnh khác.");
        } finally {
            setReadingImage(false);
        }
    };

    const submitTyped = (e: FormEvent) => {
        e.preventDefault();
        const code = typed.trim();
        if (!TRACKING_CODE.test(code)) {
            setHint("Mã vận đơn chỉ gồm chữ, số, dấu chấm, gạch dưới và gạch ngang (tối đa 64 ký tự).");
            return;
        }
        accept(code, "manual");
    };

    const switchMode = (next: "camera" | "manual") => {
        setMode(next);
        setHint(null);
        setChoices(null);
        lastRead.current = null;
    };

    return (
        <div className="scanner">
            {mode === "camera" ? (
                <div className="camera-frame">
                    <video ref={camera.videoRef} className="camera-video" muted playsInline autoPlay />
                    {camera.status === "live" && (
                        <>
                            <div className="scan-guide" aria-hidden="true" />
                            <p className="camera-caption">Đưa mã vạch trên nhãn vận đơn vào khung</p>
                        </>
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
                </div>
            ) : (
                <form className="form manual-entry" onSubmit={submitTyped}>
                    <Alert tone="warn" title="Chỉ nhập tay khi nhãn bị hỏng">
                        Đơn và video dùng mã nhập tay sẽ được đánh dấu để người duyệt biết bằng chứng yếu hơn.
                    </Alert>
                    <label className="field">
                        <span className="field-label">Mã vận đơn in trên nhãn</span>
                        <input
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            autoFocus
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                        />
                    </label>
                    <Button type="submit" variant="primary">
                        Xác nhận mã
                    </Button>
                </form>
            )}

            {choices && (
                <div className="scan-choices">
                    <p className="field-label">Nhãn có nhiều mã. Chọn mã vận đơn:</p>
                    <div className="scan-choices-list">
                        {choices.codes.map((code) => (
                            <Button key={code} onClick={() => accept(code, choices.method)}>
                                {code}
                            </Button>
                        ))}
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setChoices(null);
                                lastRead.current = null;
                            }}
                        >
                            Quét lại
                        </Button>
                    </div>
                </div>
            )}

            {hint && <Alert tone="warn">{hint}</Alert>}

            <div className="scanner-actions">
                {allowImage && (
                    <label className="btn btn-secondary">
                        {readingImage ? <Spinner small /> : <IconUpload size={18} />}
                        Chọn ảnh nhãn từ máy (demo)
                        <input
                            type="file"
                            accept="image/*"
                            className="visually-hidden"
                            onChange={readImage}
                            disabled={readingImage}
                        />
                    </label>
                )}
                {mode === "camera" ? (
                    <Button variant="ghost" onClick={() => switchMode("manual")}>
                        Nhãn bị hỏng? Nhập tay
                    </Button>
                ) : (
                    <Button variant="ghost" onClick={() => switchMode("camera")}>
                        Quay lại quét bằng camera
                    </Button>
                )}
            </div>
        </div>
    );
};
