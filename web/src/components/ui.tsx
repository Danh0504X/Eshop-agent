import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import { describeError } from "../lib/api";
import { IconAlert, IconChevronLeft } from "./icons";

export const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

const buttonClass = (variant: Variant, size: Size, block?: boolean, className?: string) =>
    cx("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", className);

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: Size;
    icon?: ReactNode;
    block?: boolean;
    busy?: boolean;
}

export const Button = ({
    variant = "secondary",
    size = "md",
    icon,
    block,
    busy,
    className,
    children,
    disabled,
    type = "button",
    ...rest
}: ButtonProps) => (
    <button type={type} className={buttonClass(variant, size, block, className)} disabled={disabled || busy} {...rest}>
        {busy ? <Spinner small /> : icon}
        {children}
    </button>
);

export const LinkButton = ({
    to,
    variant = "secondary",
    size = "md",
    icon,
    block,
    current,
    children,
}: {
    to: string;
    variant?: Variant;
    size?: Size;
    icon?: ReactNode;
    block?: boolean;
    /** Marks the button as the page the person is on (used for the sidebar actions). */
    current?: boolean;
    children: ReactNode;
}) => (
    <Link
        to={to}
        className={buttonClass(variant, size, block, current ? "btn-current" : undefined)}
        aria-current={current ? "page" : undefined}
    >
        {icon}
        {children}
    </Link>
);

export const Spinner = ({ small }: { small?: boolean }) => (
    <span className={cx("spinner", small && "spinner-sm")} role="status" aria-label="Đang tải" />
);

export const PageHeader = ({
    title,
    subtitle,
    actions,
    backTo,
}: {
    title: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    backTo?: string;
}) => (
    <header className="page-header">
        <div className="page-header-text">
            {backTo && (
                <Link to={backTo} className="back-link">
                    <IconChevronLeft size={18} />
                    Quay lại
                </Link>
            )}
            <h1>{title}</h1>
            {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
    </header>
);

export const Card = ({
    title,
    actions,
    children,
    className,
}: {
    title?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}) => (
    <section className={cx("card", className)}>
        {(title || actions) && (
            <div className="card-header">
                {title && <h2>{title}</h2>}
                {actions && <div className="card-actions">{actions}</div>}
            </div>
        )}
        <div className="card-body">{children}</div>
    </section>
);

export type Tone = "neutral" | "info" | "ok" | "warn" | "bad";

export const Pill = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => (
    <span className={cx("pill", `pill-${tone}`)}>{children}</span>
);

export const Alert = ({ tone = "info", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) => (
    <div className={cx("alert", `alert-${tone}`)} role={tone === "bad" ? "alert" : "status"}>
        {(tone === "bad" || tone === "warn") && <IconAlert size={18} className="alert-icon" />}
        <div>
            {title && <p className="alert-title">{title}</p>}
            {children && <div className="alert-text">{children}</div>}
        </div>
    </div>
);

/** Friendly Vietnamese message for a failed request, with the backend's message as detail. */
export const ErrorAlert = ({ error }: { error: unknown }) => {
    if (!error) return null;
    const { title, detail } = describeError(error);
    return (
        <Alert tone="bad" title={title}>
            {detail}
        </Alert>
    );
};

export const EmptyState = ({
    icon,
    title,
    children,
    action,
}: {
    icon?: ReactNode;
    title: ReactNode;
    children?: ReactNode;
    action?: ReactNode;
}) => (
    <div className="empty">
        {icon && <div className="empty-icon">{icon}</div>}
        <p className="empty-title">{title}</p>
        {children && <p className="empty-text">{children}</p>}
        {action}
    </div>
);
