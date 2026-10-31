import { useHealth } from "../lib/health";
import { Pill } from "./ui";

const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini" };

/**
 * Always-visible analysis mode, so demo data is never mistaken for a real AI result, plus the demo
 * allowance for attaching files from the computer.
 */
export const ModeChips = () => {
    const { health } = useHealth();
    if (!health) return null;
    return (
        <div className="mode-chips">
            {health.analysisMode === "demo" ? (
                <Pill tone="warn">Dữ liệu demo</Pill>
            ) : (
                <Pill tone="ok">AI thật · {PROVIDER_LABEL[health.aiProvider ?? ""] ?? health.aiProvider ?? "AI"}</Pill>
            )}
            {health.allowFileEvidence && <Pill tone="info">Tải file từ máy (demo)</Pill>}
        </div>
    );
};
