import type { Media, NewOrderInput, Order, Scan, ScanMethod, ScanPurpose, User } from "./types";

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

export interface EvidenceUpload {
    type: "outbound" | "return";
    scanId: string;
    file: File;
    captureMethod: "recorded" | "file";
    recordingStartedAt?: Date;
    recordingEndedAt?: Date;
}

export const api = {
    login: (email: string, password: string) =>
        request<{ token: string; user: User }>("POST", "/api/auth/login", { email, password }),
    me: () => request<{ user: User }>("GET", "/api/auth/me"),

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
        form.append("file", evidence.file);
        return upload<{ media: Media }>(`/api/orders/${encodeURIComponent(orderId)}/media`, form, onProgress);
    },
};

const ERROR_TITLES: Record<string, string> = {
    NETWORK_ERROR: "Không kết nối được máy chủ. Kiểm tra mạng hoặc backend.",
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

/** A short Vietnamese message for the person; the backend's own message is kept as detail. */
export const describeError = (error: unknown): { title: string; detail?: string } => {
    if (error instanceof ApiError) {
        const title = ERROR_TITLES[error.code] ?? "Đã xảy ra lỗi, vui lòng thử lại.";
        return error.code === "NETWORK_ERROR" ? { title } : { title, detail: error.message };
    }
    return { title: "Đã xảy ra lỗi, vui lòng thử lại.", detail: error instanceof Error ? error.message : undefined };
};
