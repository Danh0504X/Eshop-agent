import type { Tone } from "../components/ui";
import type { Inspection } from "./types";

/** Why a person has to look, for each escalation code the backend can raise. */
export const ESCALATION_TEXT: Record<string, string> = {
    EVIDENCE_MISSING: "Thiếu video đóng gói hoặc video hoàn trả.",
    EVIDENCE_NOT_SCANNED: "Có video không được tải lên qua bước quét nhãn. Hãy quét nhãn và tải lại video.",
    ORDER_ID_MISMATCH: "Có video đang gắn với một đơn khác.",
    FILE_UNREADABLE: "Không đọc được file video.",
    EXTRACTION_FAILED: "Không trích được khung hình (video quá ngắn, quá dài hoặc bị hỏng).",
    FRAMES_MISSING: "Thiếu khung hình của video.",
    POOR_VIDEO_QUALITY: "Video quá tối hoặc quá mờ. Hãy quay lại video rõ hơn.",
    POSSIBLE_DISCONTINUITY: "Video có thể bị cắt hoặc không liền mạch.",
    ANALYSIS_UNUSABLE: "AI không dùng được khung hình của video để phân tích.",
    LOW_CONFIDENCE: "Độ tin cậy của AI thấp hơn ngưỡng cho phép.",
    KEY_ATTRIBUTE_UNVERIFIABLE: "Không xác minh được số lượng hoặc hộp có hàng hay không từ video.",
    INSTRUCTION_TEXT_IN_FOOTAGE: "Trong video có chữ giống lệnh gửi cho AI; AI đã bỏ qua, cần người xem lại.",
    WORKFLOW_ERROR: "Quy trình kiểm tra dừng giữa chừng (ví dụ lỗi khi gọi AI).",
};

export const FINDING_TITLE: Record<string, string> = {
    empty_package: "Hộp rỗng khi mở hàng hoàn",
    quantity_mismatch: "Số lượng khác nhau",
    outbound_quantity_differs_from_order: "Số lượng lúc đóng gói khác với đơn",
    product_type_mismatch: "Loại sản phẩm khác nhau",
    model_mismatch: "Model khác nhau",
    color_mismatch: "Màu sắc khác nhau",
    missing_accessory: "Thiếu phụ kiện",
    packaging_condition_change: "Bao bì xấu đi",
    product_condition_change: "Sản phẩm có hư hỏng mới",
};

export const SEVERITY: Record<string, { label: string; tone: Tone }> = {
    critical: { label: "Nghiêm trọng", tone: "bad" },
    high: { label: "Cao", tone: "bad" },
    medium: { label: "Trung bình", tone: "warn" },
    low: { label: "Thấp", tone: "neutral" },
};

const OBSERVATION_TEXT: Record<string, string> = {
    "not visible": "không thấy",
    "items present": "có hàng",
    "package appears empty": "hộp rỗng",
    present: "có",
    absent: "không có",
    intact: "nguyên vẹn",
    minor_damage: "hư hỏng nhẹ",
    major_damage: "hư hỏng nặng",
    opened_or_tampered: "đã bị mở",
    "surface not visible": "không thấy bề mặt",
    "no visible damage": "không thấy hư hỏng",
};

/** Backend observations such as "2 (observed)" or "minor_damage; dent on a corner", for reading. */
export const observationText = (value: string | null): string => {
    if (!value) return "-";
    const [head, ...rest] = value.replace(/\s*\((observed|uncertain)\)$/, "").split("; ");
    return [OBSERVATION_TEXT[head] ?? head, ...rest].join("; ");
};

const ATTRIBUTE_TEXT: Record<string, string> = {
    "Package contents": "Hộp có hàng hay không",
    "Item quantity": "Số lượng",
    "Product type": "Loại sản phẩm",
    Model: "Model",
    Colour: "Màu sắc",
    "Packaging condition": "Tình trạng bao bì",
    "Product condition": "Tình trạng sản phẩm",
};

export const attributeText = (attribute: string): string =>
    ATTRIBUTE_TEXT[attribute] ??
    attribute.replace(/^Accessory /, "Phụ kiện ").replace(/^Product condition /, "Tình trạng sản phẩm ");

/** The one-line verdict shown at the top of a finished inspection. */
export const verdict = (inspection: Inspection): { tone: Tone; title: string } => {
    if (inspection.status === "failed") return { tone: "bad", title: "Kiểm tra không thành công" };
    if (inspection.status === "needs_review")
        return inspection.claimId
            ? { tone: "warn", title: "Phát hiện sai lệch, đã tạo khiếu nại nháp và cần người xem" }
            : { tone: "warn", title: "Chưa kết luận được, cần người kiểm tra" };
    return inspection.claimId
        ? { tone: "warn", title: "Phát hiện sai lệch, đã tạo khiếu nại nháp" }
        : { tone: "ok", title: "Hàng trả về khớp với lúc đóng gói" };
};

export const PROGRESS_STEPS = ["Kiểm tra video", "AI phân tích từng video", "So sánh và kết luận"];

/** Index in PROGRESS_STEPS for a backend workflow state. */
export const progressIndex = (workflowState: string): number => {
    if (["COMPARISON", "VERIFICATION", "CLAIM_DRAFT"].includes(workflowState)) return 2;
    if (["FRAME_EXTRACTION", "ITEM_ANALYSIS", "ADDITIONAL_INSPECTION"].includes(workflowState)) return 1;
    return 0;
};
