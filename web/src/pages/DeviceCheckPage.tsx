import { useEffect, useState } from "react";
import { LabelScanner, type ScanMethod } from "../components/LabelScanner";
import { Button, Card, PageHeader } from "../components/ui";
import { formatDuration, formatSize, VideoCapture, type Capture } from "../components/VideoCapture";
import { useHealth } from "../lib/health";

const METHOD_LABEL: Record<ScanMethod, string> = {
    camera: "Quét bằng camera",
    image_file: "Đọc từ ảnh tải lên (demo)",
    manual: "Nhập tay (bằng chứng yếu hơn)",
};

const fmtTime = (d?: Date) => (d ? d.toLocaleTimeString("vi-VN") : "-");

/**
 * Development page (only routed by the dev server) for trying the label scanner and the video recorder on a
 * device. Nothing is sent to the backend.
 */
export const DeviceCheckPage = () => {
    const { health } = useHealth();
    const allowFile = Boolean(health?.allowFileEvidence);
    const [tab, setTab] = useState<"scan" | "record">("scan");
    const [scan, setScan] = useState<{ code: string; method: ScanMethod } | null>(null);
    const [capture, setCapture] = useState<Capture | null>(null);
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!capture) return;
        const url = URL.createObjectURL(capture.file);
        setDownloadUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [capture]);

    const again = () => {
        setScan(null);
        setCapture(null);
        setAttempt((n) => n + 1);
    };

    return (
        <div className="device-check">
            <PageHeader
                title="Thử camera"
                subtitle="Trang dành cho phát triển: thử quét mã vận đơn và quay video. Không gửi gì lên máy chủ."
            />
            <div className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === "scan"} onClick={() => setTab("scan")}>
                    Quét mã vận đơn
                </button>
                <button role="tab" aria-selected={tab === "record"} onClick={() => setTab("record")}>
                    Quay video
                </button>
            </div>

            {tab === "scan" && (
                <Card title="Quét mã vận đơn">
                    {scan ? (
                        <div className="result">
                            <p className="result-code">{scan.code}</p>
                            <p className="result-sub">{METHOD_LABEL[scan.method]}</p>
                            <Button onClick={again}>Quét lại</Button>
                        </div>
                    ) : (
                        <LabelScanner
                            key={attempt}
                            allowImage={allowFile}
                            onDetected={(code, method) => setScan({ code, method })}
                        />
                    )}
                </Card>
            )}

            {tab === "record" && (
                <Card title="Quay video">
                    {capture ? (
                        <div className="result">
                            <dl className="meta-list">
                                <dt>Cách tạo</dt>
                                <dd>
                                    {capture.captureMethod === "recorded" ? "Quay trong app" : "File từ máy (demo)"}
                                </dd>
                                <dt>File</dt>
                                <dd>
                                    {capture.file.name} · {capture.file.type || "không rõ"} ·{" "}
                                    {formatSize(capture.file.size)}
                                </dd>
                                <dt>Độ dài</dt>
                                <dd>{capture.durationSec !== undefined ? formatDuration(capture.durationSec) : "-"}</dd>
                                <dt>Bắt đầu / kết thúc</dt>
                                <dd>
                                    {fmtTime(capture.recordingStartedAt)} / {fmtTime(capture.recordingEndedAt)}
                                </dd>
                            </dl>
                            <div className="row-actions">
                                {downloadUrl && (
                                    <a className="btn btn-secondary" href={downloadUrl} download={capture.file.name}>
                                        Tải video về
                                    </a>
                                )}
                                <Button onClick={again}>Quay lại</Button>
                            </div>
                        </div>
                    ) : (
                        <VideoCapture key={attempt} allowFile={allowFile} onCaptured={setCapture} confirmLabel="Xong" />
                    )}
                </Card>
            )}
        </div>
    );
};
