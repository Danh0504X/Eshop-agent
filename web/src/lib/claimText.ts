import type { Tone } from "../components/ui";
import type { ClaimStatus, FinalDetermination } from "./types";

export const CLAIM_STATUS: Record<ClaimStatus, { label: string; tone: Tone }> = {
    draft: { label: "Bản nháp", tone: "neutral" },
    pending_approval: { label: "Chờ duyệt", tone: "warn" },
    approved: { label: "Đã duyệt", tone: "info" },
    submitted: { label: "Đã gửi", tone: "info" },
    rejected: { label: "Đã từ chối", tone: "neutral" },
    resolved: { label: "Đã xong", tone: "ok" },
};

export const CLAIM_STATUSES = Object.keys(CLAIM_STATUS) as ClaimStatus[];

export const DETERMINATION: Record<FinalDetermination, string> = {
    no_determination: "Chưa kết luận",
    discrepancy_confirmed_by_reviewer: "Xác nhận có sai lệch",
    no_discrepancy: "Không có sai lệch",
    inconclusive: "Không đủ căn cứ",
};

export const DETERMINATIONS = Object.keys(DETERMINATION) as FinalDetermination[];

/** Reasons written by the backend are in English; the ones people type are shown as they are. */
export const historyReason = (reason?: string): string | undefined => {
    if (reason === "Draft generated from inspection") return "AI tạo bản nháp từ kết quả kiểm tra.";
    if (reason === "Report generated; awaiting human review") return "Đã tạo báo cáo, chờ người duyệt.";
    return reason
        ?.replace(
            "Submitted manually by a reviewer outside FixIt (no automatic external submission)",
            "Người duyệt đã gửi thủ công bên ngoài FixIt",
        )
        .replace(/; reference /, "; mã tham chiếu ");
};
