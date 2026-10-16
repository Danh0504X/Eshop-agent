import { useEffect, useState } from "react";
import { Badge } from "./components/common";
import { ClaimsPage } from "./pages/ClaimsPage";
import { LoginPage } from "./pages/LoginPage";
import { OrdersPage } from "./pages/OrdersPage";
import { api, tokenStore } from "./services/api";
import type { Health, User } from "./types";

export const App = () => {
    const [user, setUser] = useState<User | null>(null);
    const [health, setHealth] = useState<Health | null>(null);
    const [healthError, setHealthError] = useState(false);
    const [checking, setChecking] = useState(Boolean(tokenStore.get()));
    const [tab, setTab] = useState<"orders" | "claims">("orders");

    useEffect(() => {
        api.health()
            .then(setHealth)
            .catch(() => setHealthError(true));
        if (tokenStore.get()) {
            api.me()
                .then(({ user }) => setUser(user))
                .catch(() => tokenStore.set(null))
                .finally(() => setChecking(false));
        }
    }, []);

    const logout = () => {
        tokenStore.set(null);
        setUser(null);
    };

    // The active analysis mode is always visible so demo data is never mistaken for real AI analysis.
    const modeBar = healthError ? (
        <div className="banner bad">Backend unreachable. Start it with "npm run dev" in backend/.</div>
    ) : health ? (
        <div className={`banner ${health.analysisMode === "demo" ? "demo" : "info"}`}>
            {health.analysisMode === "demo"
                ? "DEMO MODE: inspections use predefined demo results, NOT real AI analysis."
                : `REAL AI MODE: model ${health.aiModel}, planner ${health.planner}.`}{" "}
            Database: {health.database}.
        </div>
    ) : null;

    if (checking) return <p className="muted">Loading…</p>;
    if (!user)
        return (
            <>
                {modeBar}
                <LoginPage onLogin={setUser} />
            </>
        );

    return (
        <>
            {modeBar}
            <header className="header">
                <b>FixIt AI Agent</b>
                <nav className="row">
                    <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>
                        Orders
                    </button>
                    <button className={tab === "claims" ? "active" : ""} onClick={() => setTab("claims")}>
                        Claims
                    </button>
                </nav>
                <span className="row small">
                    {user.name} <Badge value={user.role} /> {user.shopId}
                    {user.role === "employee" && ` (${user.warehouseIds.join(", ")})`}
                    <button onClick={logout}>Log out</button>
                </span>
            </header>
            <main>{tab === "orders" ? <OrdersPage user={user} /> : <ClaimsPage user={user} />}</main>
        </>
    );
};
