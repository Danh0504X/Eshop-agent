import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** Simple stroke icons drawn on a 24x24 grid; they inherit the text colour. */
const Icon = ({ size = 20, children, ...rest }: IconProps) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
    >
        {children}
    </svg>
);

export const IconBox = (props: IconProps) => (
    <Icon {...props}>
        <path d="M21 8l-9-5-9 5 9 5 9-5z" />
        <path d="M3 8v8l9 5 9-5V8" />
        <path d="M12 13v8" />
    </Icon>
);

export const IconPlus = (props: IconProps) => (
    <Icon {...props}>
        <path d="M12 5v14M5 12h14" />
    </Icon>
);

export const IconReturn = (props: IconProps) => (
    <Icon {...props}>
        <path d="M9 14L4 9l5-5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Icon>
);

export const IconClaim = (props: IconProps) => (
    <Icon {...props}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M12 11v4M12 18h.01" />
    </Icon>
);

export const IconLogout = (props: IconProps) => (
    <Icon {...props}>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="M16 17l5-5-5-5M21 12H9" />
    </Icon>
);

export const IconScan = (props: IconProps) => (
    <Icon {...props}>
        <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
        <path d="M7 8v8M10 8v8M13 8v8M17 8v8" />
    </Icon>
);

export const IconAlert = (props: IconProps) => (
    <Icon {...props}>
        <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
    </Icon>
);

export const IconUpload = (props: IconProps) => (
    <Icon {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M17 8l-5-5-5 5M12 3v12" />
    </Icon>
);

export const IconChevronLeft = (props: IconProps) => (
    <Icon {...props}>
        <path d="M15 18l-6-6 6-6" />
    </Icon>
);
