import { IconCheck } from "./icons";
import { cx } from "./ui";

/** Numbered steps of a flow. A `step` that is not in `steps` (the done screen) marks all of them as done. */
export const Stepper = ({
    steps,
    step,
    skipped,
}: {
    steps: Array<{ id: string; label: string }>;
    step: string;
    skipped?: string;
}) => {
    const index = steps.findIndex((s) => s.id === step);
    const current = index === -1 ? steps.length : index;
    return (
        <ol className="stepper">
            {steps.map((s, i) => {
                const state = i < current ? "done" : i === current ? "current" : "todo";
                return (
                    <li
                        key={s.id}
                        className={cx("step", `step-${state}`)}
                        aria-current={state === "current" ? "step" : undefined}
                    >
                        <span className="step-num">{state === "done" ? <IconCheck size={16} /> : i + 1}</span>
                        <span className="step-label">
                            {s.label}
                            {skipped === s.id && <span className="step-note"> (đơn đã có)</span>}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
};

export const ProgressBar = ({ value }: { value: number }) => (
    <div
        className="upload-progress"
        role="progressbar"
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
    >
        <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.round(value * 100)}%` }} />
        </div>
        <span>Đang tải video lên… {Math.round(value * 100)}%</span>
    </div>
);
