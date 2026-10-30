import type { Tone } from "../components/ui";
import type { Order } from "./types";

/** One status for the person, combined from which videos exist and the latest inspection. */
export const orderStatus = (order: Order): { label: string; tone: Tone } => {
    if (!order.packingMedia.length) return { label: "Chờ video đóng gói", tone: "warn" };
    if (!order.returnMedia.length) return { label: "Chờ hàng hoàn", tone: "neutral" };
    switch (order.inspectionStatus) {
        case "pending":
        case "processing":
            return { label: "Đang kiểm tra", tone: "info" };
        case "needs_review":
            return { label: "Cần xem xét", tone: "warn" };
        case "completed":
            return order.latestClaimId ? { label: "Có sai lệch", tone: "bad" } : { label: "Khớp", tone: "ok" };
        case "failed":
            return { label: "Kiểm tra lỗi", tone: "bad" };
        default:
            return { label: "Chờ kiểm tra", tone: "info" };
    }
};

export const formatDateTime = (value?: string) =>
    value ? new Date(value).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "-";
