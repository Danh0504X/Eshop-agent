import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, tokenStore, UNAUTHORIZED_EVENT } from "./api";
import type { Role, User } from "./types";

interface AuthState {
    user: User | null;
    /** False while a stored token is being checked on startup. */
    ready: boolean;
    login: (email: string, password: string) => Promise<void>;
    logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [user, setUser] = useState<User | null>(null);
    const [ready, setReady] = useState(!tokenStore.get());

    useEffect(() => {
        if (tokenStore.get()) {
            api.me()
                .then(({ user }) => setUser(user))
                .catch(() => tokenStore.set(null))
                .finally(() => setReady(true));
        }
        const onUnauthorized = () => setUser(null);
        window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
        return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const { token, user } = await api.login(email, password);
        tokenStore.set(token);
        setUser(user);
    }, []);

    const logout = useCallback(() => {
        tokenStore.set(null);
        setUser(null);
    }, []);

    const value = useMemo(() => ({ user, ready, login, logout }), [user, ready, login, logout]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthState => {
    const auth = useContext(AuthContext);
    if (!auth) throw new Error("useAuth must be used inside <AuthProvider>");
    return auth;
};

export const ROLE_LABEL: Record<Role, string> = { owner: "Chủ shop", employee: "Nhân viên kho" };
