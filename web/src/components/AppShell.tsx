import type { ComponentType } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { ROLE_LABEL, useAuth } from "../lib/auth";
import { useHealth } from "../lib/health";
import { IconBox, IconClaim, IconLogout, IconPlus, IconReturn } from "./icons";
import { ModeChips } from "./ModeChips";
import { Alert, cx, LinkButton } from "./ui";

interface NavItem {
    to: string;
    label: string;
    shortLabel: string;
    icon: ComponentType<{ size?: number }>;
    /** Whether this item is the current page. */
    match: (path: string) => boolean;
}

const isNewOrder = (path: string) => path === "/orders/new";
const ORDERS: NavItem = {
    to: "/orders",
    label: "Đơn hàng",
    shortLabel: "Đơn hàng",
    icon: IconBox,
    match: (path) => path.startsWith("/orders") && !isNewOrder(path),
};
const NEW_ORDER: NavItem = {
    to: "/orders/new",
    label: "Thêm đơn",
    shortLabel: "Thêm đơn",
    icon: IconPlus,
    match: isNewOrder,
};
const RETURN: NavItem = {
    to: "/returns/new",
    label: "Nhận hàng hoàn",
    shortLabel: "Nhận hoàn",
    icon: IconReturn,
    match: (path) => path.startsWith("/returns"),
};
const CLAIMS: NavItem = {
    to: "/claims",
    label: "Khiếu nại",
    shortLabel: "Khiếu nại",
    icon: IconClaim,
    match: (path) => path.startsWith("/claims"),
};

const Brand = () => (
    <Link to="/orders" className="brand">
        <span className="brand-mark">F</span>
        <span className="brand-name">FixIt</span>
        <span className="brand-sub">Kiểm hàng hoàn</span>
    </Link>
);

/**
 * App layout: a sidebar with the two main actions on wide screens, a bottom tab bar on phones (where scanning
 * and recording happen), and a top bar that always shows the analysis mode.
 */
export const AppShell = () => {
    const { user, logout } = useAuth();
    const { health, unreachable } = useHealth();
    const { pathname } = useLocation();

    const navLink = (item: NavItem) => {
        const Icon = item.icon;
        return (
            <Link
                key={item.to}
                to={item.to}
                className={cx("nav-item", item.match(pathname) && "active")}
                aria-current={item.match(pathname) ? "page" : undefined}
            >
                <Icon size={20} />
                {item.label}
            </Link>
        );
    };

    return (
        <div className="shell">
            <aside className="sidebar">
                <Brand />
                <div className="sidebar-actions">
                    <LinkButton
                        to={NEW_ORDER.to}
                        variant="primary"
                        icon={<IconPlus size={18} />}
                        block
                        current={NEW_ORDER.match(pathname)}
                    >
                        Thêm đơn
                    </LinkButton>
                    <LinkButton to={RETURN.to} icon={<IconReturn size={18} />} block current={RETURN.match(pathname)}>
                        Nhận hàng hoàn
                    </LinkButton>
                </div>
                <nav className="sidebar-nav" aria-label="Điều hướng chính">
                    {[ORDERS, CLAIMS].map(navLink)}
                </nav>
                {user && (
                    <div className="sidebar-user">
                        <div className="avatar" aria-hidden="true">
                            {user.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="sidebar-user-text">
                            <span className="sidebar-user-name">{user.name}</span>
                            <span className="sidebar-user-role">{ROLE_LABEL[user.role]}</span>
                        </div>
                        <button className="icon-btn" onClick={logout} title="Đăng xuất" aria-label="Đăng xuất">
                            <IconLogout size={18} />
                        </button>
                    </div>
                )}
            </aside>

            <div className="main-col">
                <header className="topbar">
                    <div className="topbar-brand">
                        <Brand />
                    </div>
                    <ModeChips />
                    {user && (
                        <button className="icon-btn topbar-logout" onClick={logout} aria-label="Đăng xuất">
                            <IconLogout size={18} />
                        </button>
                    )}
                </header>
                {(unreachable || health?.database === "disconnected") && (
                    <div className="shell-alert">
                        <Alert tone="bad" title="Không kết nối được máy chủ">
                            {unreachable
                                ? "Backend không phản hồi. Kiểm tra backend đã chạy (npm run dev trong backend/)."
                                : "Backend đang chạy nhưng mất kết nối cơ sở dữ liệu."}
                        </Alert>
                    </div>
                )}
                <main className="content">
                    <Outlet />
                </main>
            </div>

            <nav className="tabbar" aria-label="Điều hướng chính">
                {[ORDERS, NEW_ORDER, RETURN, CLAIMS].map((item) => {
                    const Icon = item.icon;
                    const active = item.match(pathname);
                    return (
                        <Link
                            key={item.to}
                            to={item.to}
                            className={cx(
                                "tab",
                                active && "active",
                                (item === NEW_ORDER || item === RETURN) && "tab-action",
                            )}
                            aria-current={active ? "page" : undefined}
                        >
                            <Icon size={22} />
                            <span>{item.shortLabel}</span>
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
};
