import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router";
import { ModeChips } from "../components/ModeChips";
import { Button, ErrorAlert } from "../components/ui";
import { useAuth } from "../lib/auth";

/** Seeded development accounts (backend/scripts/seed.ts). Shown only by the Vite dev server. */
const DEV_ACCOUNTS = [
    { email: "owner@demo-shop.test", label: "Chủ shop" },
    { email: "staff@demo-shop.test", label: "Nhân viên kho (wh-hcm)" },
    { email: "owner@other-shop.test", label: "Chủ shop khác" },
];
const DEV_PASSWORD = "dev-password-change-me";

export const LoginPage = () => {
    const { user, login } = useAuth();
    const location = useLocation();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);

    const from = (location.state as { from?: string } | null)?.from ?? "/orders";
    if (user) return <Navigate to={from} replace />;

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await login(email.trim(), password);
        } catch (err) {
            setError(err);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="login">
            <div className="login-card">
                <div className="login-brand">
                    <span className="brand-mark brand-mark-lg">F</span>
                    <div>
                        <p className="login-title">FixIt</p>
                        <p className="login-subtitle">Kiểm tra hàng hoàn bằng video đóng gói và video mở hàng</p>
                    </div>
                </div>

                <form className="form" onSubmit={submit}>
                    <label className="field">
                        <span className="field-label">Email</span>
                        <input
                            type="email"
                            autoComplete="username"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </label>
                    <label className="field">
                        <span className="field-label">Mật khẩu</span>
                        <input
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </label>
                    {error ? (
                        (error as { status?: number }).status === 401 ? (
                            <p className="form-error">Email hoặc mật khẩu không đúng.</p>
                        ) : (
                            <ErrorAlert error={error} />
                        )
                    ) : null}
                    <Button type="submit" variant="primary" size="lg" block busy={busy}>
                        Đăng nhập
                    </Button>
                </form>

                <ModeChips />

                {import.meta.env.DEV && (
                    <div className="dev-accounts">
                        <p className="dev-accounts-title">Tài khoản dev (dữ liệu seed)</p>
                        {DEV_ACCOUNTS.map((account) => (
                            <button
                                key={account.email}
                                type="button"
                                className="dev-account"
                                onClick={() => {
                                    setEmail(account.email);
                                    setPassword(DEV_PASSWORD);
                                }}
                            >
                                <span>{account.label}</span>
                                <span className="dev-account-email">{account.email}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
