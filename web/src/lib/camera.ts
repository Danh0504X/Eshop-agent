import { useEffect, useRef, useState } from "react";

export type CameraStatus = "idle" | "starting" | "live" | "error";

const cameraErrorMessage = (error: unknown): string => {
    const name = (error as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "SecurityError")
        return "Trình duyệt đã chặn quyền dùng camera. Hãy cho phép camera cho trang này rồi thử lại.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "Không tìm thấy camera trên thiết bị này.";
    if (name === "NotReadableError" || name === "AbortError")
        return "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.";
    return "Không mở được camera.";
};

/**
 * Open the camera (the rear one when there is a choice) while `enabled`, show it in the returned video element
 * and release it when disabled or unmounted. Browsers only allow cameras on HTTPS or localhost.
 */
export const useCamera = (enabled: boolean) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [status, setStatus] = useState<CameraStatus>("idle");
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!enabled) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            setStatus("error");
            setError(
                window.isSecureContext
                    ? "Trình duyệt này không hỗ trợ camera."
                    : "Trình duyệt chỉ cho dùng camera trên HTTPS hoặc localhost. Hãy mở trang bằng địa chỉ HTTPS.",
            );
            return;
        }
        let opened: MediaStream | null = null;
        let cancelled = false;
        setStatus("starting");
        setError(null);
        navigator.mediaDevices
            .getUserMedia({
                audio: false,
                video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
            })
            .then((s) => {
                if (cancelled) {
                    s.getTracks().forEach((track) => track.stop());
                    return;
                }
                opened = s;
                setStream(s);
                setStatus("live");
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setStatus("error");
                setError(cameraErrorMessage(e));
            });
        return () => {
            cancelled = true;
            opened?.getTracks().forEach((track) => track.stop());
            setStream(null);
            setStatus("idle");
        };
    }, [enabled, attempt]);

    // Attach the stream whenever the video element or the stream changes.
    useEffect(() => {
        const video = videoRef.current;
        if (video && stream && video.srcObject !== stream) {
            video.srcObject = stream;
            void video.play().catch(() => undefined);
        }
    });

    return { videoRef, stream, status, error, retry: () => setAttempt((n) => n + 1) };
};
