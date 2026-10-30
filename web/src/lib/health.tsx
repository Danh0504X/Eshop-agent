import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Health } from "./types";

interface HealthState {
    health: Health | null;
    /** The backend did not answer at all. */
    unreachable: boolean;
    refresh: () => void;
}

const HealthContext = createContext<HealthState | null>(null);
const REFRESH_MS = 60_000;

/**
 * Backend status and modes (real AI vs demo data, file attachments allowed). Read without auth; a 503 still
 * carries a body that says the database is down, so the response is parsed whatever its status.
 */
export const HealthProvider = ({ children }: { children: ReactNode }) => {
    const [health, setHealth] = useState<Health | null>(null);
    const [unreachable, setUnreachable] = useState(false);

    const refresh = useCallback(() => {
        fetch("/api/health")
            .then((response) => response.json() as Promise<Health>)
            .then((body) => {
                setHealth(body);
                setUnreachable(false);
            })
            .catch(() => setUnreachable(true));
    }, []);

    useEffect(() => {
        refresh();
        const timer = window.setInterval(refresh, REFRESH_MS);
        window.addEventListener("focus", refresh);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", refresh);
        };
    }, [refresh]);

    const value = useMemo(() => ({ health, unreachable, refresh }), [health, unreachable, refresh]);
    return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
};

export const useHealth = (): HealthState => {
    const state = useContext(HealthContext);
    if (!state) throw new Error("useHealth must be used inside <HealthProvider>");
    return state;
};
