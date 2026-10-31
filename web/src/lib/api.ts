import type {
    Claim,
    FinalDetermination,
    Inspection,
    InspectionRun,
    Media,
    NewOrderInput,
    Order,
    Scan,
    ScanMethod,
    ScanPurpose,
    User,
} from "./types";

const TOKEN_KEY = "fixit.web.token";
/** Fired when the backend rejects the stored token, so the app can return to the login screen. */
export const UNAUTHORIZED_EVENT = "fixit:unauthorized";

export const tokenStore = {
    get: (): string | null => {
        try {
            return localStorage.getItem(TOKEN_KEY);
        } catch {
            return null;
        }
    },
    set: (token: string | null) => {
        try {
            if (token) localStorage.setItem(TOKEN_KEY, token);
            else localStorage.removeItem(TOKEN_KEY);
        } catch {
            /* storage unavailable: the session lasts until reload */
        }
    },
};

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly details: unknown[] = [],
    ) {
        super(message);
        this.name = "ApiError";
    }
}

type Body = Record<string, unknown> | FormData | undefined;

export const request = async <T>(method: string, path: string, body?: Body): Promise<T> => {
    const headers: Record<string, string> = {};
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
        response = await fetch(path, {
            method,
            headers,
            body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new ApiError(0, "NETWORK_ERROR", "The server could not be reached");
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) {
        if (response.status === 401 && token) {
            tokenStore.set(null);
            window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        }
        throw new ApiError(
            response.status,
            json?.code ?? "HTTP_ERROR",
            json?.message ?? `Request failed (${response.status})`,
            json?.errors ?? [],
        );
    }
    return (json?.data ?? json) as T;
};

/**
 * Multipart upload with progress (fetch cannot report upload progress). Same envelope and errors as `request`.
 */
export const upload = <T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> =>
    new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", path);
        const token = tokenStore.get();
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress?.(e.loaded / e.total);
        };
        xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", "The server could not be reached"));
        xhr.onload = () => {
            let json: { data?: T; code?: string; message?: string; errors?: unknown[] } | null = null;
            try {
                json = JSON.parse(xhr.responseText);
            } catch {
                /* non-JSON body */
            }
            if (xhr.status >= 200 && xhr.status < 300) return resolve((json?.data ?? json) as T);
            if (xhr.status === 401 && token) {
                tokenStore.set(null);
                window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
            }
            reject(
                new ApiError(
                    xhr.status,
                    json?.code ?? "HTTP_ERROR",
                    json?.message ?? `Request failed (${xhr.status})`,
                    json?.errors ?? [],
                ),
            );
        };
        xhr.send(form);
    });

/** Fetch a protected file with the auth header and return an object URL for it. */
export const fetchObjectUrl = async (path: string): Promise<string> => {
    const token = tokenStore.get();
    let response: Response;
    try {
        response = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    } catch {
        throw new ApiError(0, "NETWORK_ERROR", "The server could not be reached");
    }
    if (!response.ok) throw new ApiError(response.status, "HTTP_ERROR", `Could not load file (${response.status})`);
    return URL.createObjectURL(await response.blob());
};

const REVOKE_AFTER_MS = 60_000;

/** Show a protected file in a new tab. The tab opens first: browsers block pop-ups opened after waiting. */
export const openInNewTab = async (path: string): Promise<void> => {
    const tab = window.open("", "_blank");
    if (!tab) throw new ApiError(0, "POPUP_BLOCKED", "The browser blocked the new tab");
    try {
        const url = await fetchObjectUrl(path);
        tab.location.href = url;
        window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    } catch (e) {
        tab.close();
        throw e;
    }
};

export const downloadFile = async (path: string, filename: string): Promise<void> => {
    const url = await fetchObjectUrl(path);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
};

export interface EvidenceUpload {
    type: "outbound" | "return";
    scanId: string;
    file: File;
    captureMethod: "recorded" | "file";
    recordingStartedAt?: Date;
    recordingEndedAt?: Date;
    /** Set to replace the order's current video of this type. */
    replacementReason?: string;
}

const query = (params: Record<string, string | undefined>) => {
    const entries = Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]));
    return entries.length ? `?${new URLSearchParams(entries)}` : "";
};

export const api = {
    login: (email: string, password: string) =>
        request<{ token: string; user: User }>("POST", "/api/auth/login", { email, password }),
    me: () => request<{ user: User }>("GET", "/api/auth/me"),

    listOrders: (search: string, status: string) =>
        request<{ orders: Order[] }>("GET", `/api/orders${query({ limit: "100", search, status })}`),
    getOrder: (orderId: string) => request<{ order: Order }>("GET", `/api/orders/${encodeURIComponent(orderId)}`),
    listMedia: (orderId: string) =>
        request<{ media: Media[] }>("GET", `/api/orders/${encodeURIComponent(orderId)}/media`),
    deleteMedia: (mediaId: string, reason: string) =>
        request<unknown>("DELETE", `/api/media/${mediaId}`, { reason, confirm: true }),

    startInspection: (orderId: string) =>
        request<{ inspection: Inspection }>("POST", `/api/orders/${encodeURIComponent(orderId)}/inspect`),
    listInspections: (orderId: string) =>
        request<{ inspections: InspectionRun[] }>("GET", `/api/orders/${encodeURIComponent(orderId)}/inspections`),
    getInspection: (id: string) => request<{ inspection: Inspection }>("GET", `/api/inspections/${id}`),
    retryInspection: (id: string) => request<{ inspection: Inspection }>("POST", `/api/inspections/${id}/retry`),

    listClaims: (params: { status?: string; orderId?: string }) =>
        request<{ claims: Claim[] }>("GET", `/api/claims${query({ limit: "100", ...params })}`),
    getClaim: (id: string) => request<{ claim: Claim }>("GET", `/api/claims/${id}`),
    approveClaim: (id: string, reason: string, finalDetermination: FinalDetermination) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/approve`, { reason, finalDetermination }),
    rejectClaim: (id: string, reason: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/reject`, { reason }),
    markSubmitted: (id: string, externalReference?: string, note?: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/mark-submitted`, { externalReference, note }),
    resolveClaim: (id: string, reason: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/resolve`, { reason }),

    scan: (code: string, purpose: ScanPurpose, method: ScanMethod) =>
        request<{ scan: Scan; order: Order | null }>("POST", "/api/scans", { code, purpose, method }),
    createOrder: (input: NewOrderInput) =>
        request<{ order: Order }>("POST", "/api/orders", input as unknown as Record<string, unknown>),
    uploadEvidence: (orderId: string, evidence: EvidenceUpload, onProgress?: (fraction: number) => void) => {
        const form = new FormData();
        form.append("type", evidence.type);
        form.append("scanId", evidence.scanId);
        form.append("captureMethod", evidence.captureMethod);
        if (evidence.recordingStartedAt) form.append("recordingStartedAt", evidence.recordingStartedAt.toISOString());
        if (evidence.recordingEndedAt) form.append("recordingEndedAt", evidence.recordingEndedAt.toISOString());
        if (evidence.replacementReason) {
            form.append("replaceExisting", "true");
            form.append("replacementReason", evidence.replacementReason);
        }
        form.append("file", evidence.file);
        return upload<{ media: Media }>(`/api/orders/${encodeURIComponent(orderId)}/media`, form, onProgress);
    },
};

const ERROR_TITLES: Record<string, string> = {
    NETWORK_ERROR: "Không kết nối được máy chủ. Kiểm tra mạng hoặc backend.",
    POPUP_BLOCKED: "Trình duyệt đã chặn tab mới. Hãy cho phép mở tab hoặc dùng nút Tải PDF.",
    UNAUTHENTICATED: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.",
    FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
    NOT_FOUND: "Không tìm thấy dữ liệu.",
    VALIDATION_ERROR: "Thông tin chưa hợp lệ.",
    CONFLICT: "Không thể thực hiện thao tác.",
    INVALID_STATE: "Không thể thực hiện thao tác.",
    RATE_LIMITED: "Thao tác quá nhiều lần, vui lòng thử lại sau ít phút.",
    PAYLOAD_TOO_LARGE: "File quá lớn.",
    UNSUPPORTED_MEDIA_TYPE: "Định dạng file không được hỗ trợ.",
};

const FIELD_MESSAGES: Record<string, string> = {
    warehouseId: "Mã kho chỉ gồm chữ không dấu, số và các ký tự . _ - (không có dấu cách).",
    "product.name": "Tên sản phẩm không được để trống.",
    expectedQuantity: "Số lượng phải là số nguyên từ 1 đến 10.000.",
    expectedAccessories: "Danh sách phụ kiện chưa hợp lệ.",
    scanId: "Phiên quét không hợp lệ, hãy quét lại nhãn.",
    reason: "Lý do cần ít nhất 5 ký tự.",
    replacementReason: "Lý do thay video cần ít nhất 5 ký tự.",
};

/** Field-by-field text for a validation error; the backend reports one entry per broken rule. */
const describeFields = (details: unknown[]): string | undefined => {
    const paths = details.flatMap((d) => (d as { path?: string }).path ?? []);
    const lines = [...new Set(paths)].map((path) => FIELD_MESSAGES[path] ?? `Trường "${path}" chưa hợp lệ.`);
    return lines.length ? lines.join(" ") : undefined;
};

/** A short Vietnamese message for the person; the backend's own message is kept as detail. */
export const describeError = (error: unknown): { title: string; detail?: string } => {
    if (error instanceof ApiError) {
        const title = ERROR_TITLES[error.code] ?? "Đã xảy ra lỗi, vui lòng thử lại.";
        if (error.code === "NETWORK_ERROR" || error.code === "POPUP_BLOCKED") return { title };
        return { title, detail: describeFields(error.details) ?? error.message };
    }
    return { title: "Đã xảy ra lỗi, vui lòng thử lại.", detail: error instanceof Error ? error.message : undefined };
};
