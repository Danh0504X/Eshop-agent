import { useState, type FormEvent } from "react";
import { ErrorText, useAction } from "../components/common";
import { api, tokenStore } from "../services/api";
import type { User } from "../types";

// Seeded development accounts (npm run seed). Not production credentials.
const DEV_ACCOUNTS = [
    { email: "owner@demo-shop.test", label: "Owner (demo-shop)" },
    { email: "staff@demo-shop.test", label: "Staff (wh-hcm)" },
    { email: "owner@other-shop.test", label: "Other shop owner" },
];

export const LoginPage = ({ onLogin }: { onLogin: (user: User) => void }) => {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const action = useAction();

    const submit = (e: FormEvent) => {
        e.preventDefault();
        void action.run(async () => {
            const { token, user } = await api.login(email, password);
            tokenStore.set(token);
            onLogin(user);
        });
    };

    return (
        <main className="login">
            <h1>FixIt AI Agent</h1>
            <form className="card stack" onSubmit={submit}>
                <label>
                    Email
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
                <label>
                    Password
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </label>
                <button type="submit" className="primary" disabled={action.busy}>
                    {action.busy ? "Signing in…" : "Sign in"}
                </button>
                <ErrorText error={action.error} />
                <div className="stack small">
                    <span className="muted">
                        Development accounts (password from SEED_USER_PASSWORD, default dev-password-change-me):
                    </span>
                    <div className="row">
                        {DEV_ACCOUNTS.map((a) => (
                            <button
                                type="button"
                                key={a.email}
                                onClick={() => {
                                    setEmail(a.email);
                                    setPassword("dev-password-change-me");
                                }}
                            >
                                {a.label}
                            </button>
                        ))}
                    </div>
                </div>
            </form>
        </main>
    );
};
