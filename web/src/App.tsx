import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AppShell } from "./components/AppShell";
import { EmptyState, LinkButton, Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { DeviceCheckPage } from "./pages/DeviceCheckPage";
import { LoginPage } from "./pages/LoginPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";

const RequireAuth = ({ children }: { children: ReactNode }) => {
    const { user, ready } = useAuth();
    const location = useLocation();
    if (!ready)
        return (
            <div className="page-loading">
                <Spinner />
            </div>
        );
    if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    return children;
};

const NotFound = () => (
    <div className="card">
        <EmptyState title="Không tìm thấy trang" action={<LinkButton to="/orders">Về danh sách đơn</LinkButton>} />
    </div>
);

export const App = () => (
    <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
            element={
                <RequireAuth>
                    <AppShell />
                </RequireAuth>
            }
        >
            <Route index element={<Navigate to="/orders" replace />} />
            <Route path="orders" element={<PlaceholderPage title="Đơn hàng" />} />
            <Route path="orders/new" element={<PlaceholderPage title="Thêm đơn hàng" />} />
            <Route path="orders/:orderId" element={<PlaceholderPage title="Chi tiết đơn" />} />
            <Route path="returns/new" element={<PlaceholderPage title="Nhận hàng hoàn" />} />
            <Route path="claims" element={<PlaceholderPage title="Khiếu nại" />} />
            <Route path="claims/:claimId" element={<PlaceholderPage title="Chi tiết khiếu nại" />} />
            {import.meta.env.DEV && <Route path="dev/devices" element={<DeviceCheckPage />} />}
            <Route path="*" element={<NotFound />} />
        </Route>
    </Routes>
);
