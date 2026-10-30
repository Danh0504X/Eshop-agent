// Shapes returned by the backend. The UI only displays what the backend decided.

export type Role = "owner" | "employee";

export interface User {
    userId: string;
    email: string;
    name: string;
    role: Role;
    shopId: string;
    warehouseIds: string[];
}

export type ScanPurpose = "packing" | "return";
export type ScanMethod = "camera" | "image_file" | "manual";

/** A shipping-label scan recorded by the backend; it authorises the next step for that tracking code. */
export interface Scan {
    id: string;
    code: string;
    purpose: ScanPurpose;
    method: ScanMethod;
    manualEntry: boolean;
    orderId: string | null;
    scannedAt: string;
    expiresAt: string;
}

export interface Order {
    _id: string;
    orderId: string;
    trackingCode: string;
    warehouseId: string;
    product: { name: string; description?: string; sku?: string; model?: string; color?: string };
    expectedQuantity: number;
    expectedAccessories: string[];
    trackingScan?: { method?: ScanMethod; manualEntry?: boolean; scannedAt?: string };
    /** Owners only. */
    customer?: { name?: string; phone?: string; address?: string };
    packingMedia: string[];
    returnMedia: string[];
    inspectionStatus: string;
    latestClaimId?: string;
    /** An ID, or the inspection itself when the backend populated it. */
    latestInspectionId?: string | { _id: string };
    createdAt: string;
    updatedAt: string;
}

export interface Media {
    _id: string;
    type: "outbound" | "return";
    status: string;
    originalName?: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
    metadata?: { durationSec?: number };
    capture?: { scanMethod: ScanMethod; manualEntry?: boolean; captureMethod: "recorded" | "file" };
    fileUrl: string;
}

export interface Finding {
    id: string;
    category: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
    outboundObservation: string | null;
    returnObservation: string | null;
    evidence: Array<{ frameId: string; type: "outbound" | "return"; timestampSec: number | null }>;
}

export interface Inspection {
    _id: string;
    status: "pending" | "processing" | "needs_review" | "completed" | "failed";
    workflowState: string;
    analysisMode: "real" | "demo";
    comparison?: { findings: Finding[]; unverifiedAttributes: string[] };
    productMatch?: { checks: Array<{ label: string; verdict: string }> };
    frameReferences: Array<{ frameId: string; imageUrl: string | null }>;
    escalation?: { reasons: string[] };
    reviewTask?: { status?: string; reasons?: string[] };
    claimId?: string;
    error?: string;
    createdAt: string;
    finishedAt?: string;
}

export interface NewOrderInput {
    scanId: string;
    warehouseId: string;
    product: { name: string; description?: string; sku?: string; model?: string; color?: string };
    expectedQuantity: number;
    expectedAccessories: string[];
    customer?: { name?: string; phone?: string; address?: string };
}

export interface Health {
    status: "ok" | "degraded";
    database: string;
    analysisMode: "real" | "demo";
    aiProvider: string | null;
    aiModel: string | null;
    planner: string;
    /** true: evidence may be attached as a file (demo); false: it must be recorded in the app. */
    allowFileEvidence?: boolean;
}
