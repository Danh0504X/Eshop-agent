import type { Claim, Health, Inspection, Media, Order, User } from "../types";

const TOKEN_KEY = "fixit.token";

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
        message: string,
        readonly details: unknown[] = [],
    ) {
        super(message);
    }
}

type Body = Record<string, unknown> | FormData | undefined;

const request = async <T>(method: string, path: string, body?: Body): Promise<T> => {
    const headers: Record<string, string> = {};
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";

    const response = await fetch(path, {
        method,
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
        if (response.status === 401) tokenStore.set(null);
        const details = (json?.errors ?? []) as Array<{ path?: string; message?: string }>;
        const extra = details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).filter(Boolean);
        throw new ApiError(
            response.status,
            [json?.message ?? `Request failed (${response.status})`, ...extra].join(" | "),
            details,
        );
    }
    return (json?.data ?? json) as T;
};

/** Fetch a protected binary (video, frame, PDF) with the auth header and return an object URL. */
export const fetchObjectUrl = async (path: string): Promise<string> => {
    const token = tokenStore.get();
    const response = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new ApiError(response.status, `Could not load file (${response.status})`);
    return URL.createObjectURL(await response.blob());
};

export const downloadFile = async (path: string, filename: string) => {
    const url = await fetchObjectUrl(path);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const qs = (params: Record<string, string | undefined>) => {
    const entries = Object.entries(params).filter(([, v]) => v) as Array<[string, string]>;
    return entries.length ? `?${new URLSearchParams(entries)}` : "";
};

export const api = {
    health: () => request<Health>("GET", "/api/health"),
    login: (email: string, password: string) =>
        request<{ token: string; user: User }>("POST", "/api/auth/login", { email, password }),
    me: () => request<{ user: User }>("GET", "/api/auth/me"),

    listOrders: (params: { status?: string; search?: string }) =>
        request<{ orders: Order[] }>("GET", `/api/orders${qs(params)}`),
    getOrder: (orderId: string) => request<{ order: Order }>("GET", `/api/orders/${encodeURIComponent(orderId)}`),
    createOrder: (body: Record<string, unknown>) => request<{ order: Order }>("POST", "/api/orders", body),

    listMedia: (orderId: string) =>
        request<{ media: Media[] }>("GET", `/api/orders/${encodeURIComponent(orderId)}/media`),
    uploadMedia: (orderId: string, form: FormData) =>
        request<{ media: Media }>("POST", `/api/orders/${encodeURIComponent(orderId)}/media`, form),
    deleteMedia: (mediaId: string, reason: string) =>
        request<unknown>("DELETE", `/api/media/${mediaId}`, { reason, confirm: true }),

    startInspection: (orderId: string) =>
        request<{ inspection: Inspection }>("POST", `/api/orders/${encodeURIComponent(orderId)}/inspect`),
    listInspections: (orderId: string) =>
        request<{ inspections: Inspection[] }>("GET", `/api/orders/${encodeURIComponent(orderId)}/inspections`),
    getInspection: (id: string) => request<{ inspection: Inspection }>("GET", `/api/inspections/${id}`),
    retryInspection: (id: string) => request<{ inspection: Inspection }>("POST", `/api/inspections/${id}/retry`),

    listClaims: (params: { status?: string; orderId?: string }) =>
        request<{ claims: Claim[] }>("GET", `/api/claims${qs(params)}`),
    getClaim: (id: string) => request<{ claim: Claim }>("GET", `/api/claims/${id}`),
    approveClaim: (id: string, reason: string, finalDetermination?: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/approve`, {
            reason,
            ...(finalDetermination ? { finalDetermination } : {}),
        }),
    rejectClaim: (id: string, reason: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/reject`, { reason }),
    markSubmitted: (id: string, externalReference?: string, note?: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/mark-submitted`, { externalReference, note }),
    resolveClaim: (id: string, reason: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/resolve`, { reason }),
    recordRefund: (id: string, requestedCompensation: number, actualRefund: number, note?: string) =>
        request<{ claim: Claim }>("POST", `/api/claims/${id}/refund`, { requestedCompensation, actualRefund, note }),
};
