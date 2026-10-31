import { FINDING_TITLE, observationText, SEVERITY } from "../lib/inspectionText";
import type { Finding } from "../lib/types";
import { AuthImage } from "./AuthImage";
import { Pill } from "./ui";

/** The image of a frame cited by a finding, when it is known. */
type FrameUrl = (frameId: string) => string | null | undefined;

const FindingRow = ({ finding, frameUrl }: { finding: Finding; frameUrl: FrameUrl }) => {
    const severity = SEVERITY[finding.severity];
    // One supporting frame from each video, next to each other.
    const frames = (["outbound", "return"] as const).flatMap((type) => {
        const evidence = finding.evidence.find((e) => e.type === type);
        const imageUrl = evidence && frameUrl(evidence.frameId);
        return evidence && imageUrl ? [{ type, evidence, imageUrl }] : [];
    });
    return (
        <li className="finding">
            <div className="finding-head">
                <span className="finding-title">{FINDING_TITLE[finding.category] ?? finding.category}</span>
                {severity && <Pill tone={severity.tone}>{severity.label}</Pill>}
            </div>
            <p className="finding-compare">
                Lúc đóng gói: <b>{observationText(finding.outboundObservation)}</b> · Khi hoàn trả:{" "}
                <b>{observationText(finding.returnObservation)}</b>
            </p>
            {frames.length > 0 && (
                <div className="finding-frames">
                    {frames.map(({ type, evidence, imageUrl }) => (
                        <figure key={type}>
                            <AuthImage src={imageUrl} alt={`Khung hình ${evidence.frameId}`} />
                            <figcaption>
                                {type === "outbound" ? "Đóng gói" : "Hoàn trả"}
                                {evidence.timestampSec !== null && ` · ${evidence.timestampSec.toFixed(1)} giây`}
                            </figcaption>
                        </figure>
                    ))}
                </div>
            )}
        </li>
    );
};

export const FindingList = ({ findings, frameUrl }: { findings: Finding[]; frameUrl: FrameUrl }) => (
    <ul className="finding-list">
        {findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} frameUrl={frameUrl} />
        ))}
    </ul>
);
