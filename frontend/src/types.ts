// Shapes returned by the backend. Kept loose on purpose: the UI only displays what the backend decided.

export interface User {
    userId: string;
    email: string;
    name: string;
    role: "owner" | "employee";
    shopId: string;
    warehouseIds: string[];
}

export interface Health {
    status: string;
    database: string;
    analysisMode: "real" | "demo";
    aiModel: string | null;
    planner: string;
    allowFileEvidence?: boolean;
}

/** A shipping-label scan. This UI has no scanner, so its codes are recorded as typed by hand ("manual"). */
export interface Scan {
    id: string;
    code: string;
    purpose: "packing" | "return";
    method: string;
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
    trackingScan?: { method?: string; manualEntry?: boolean; scannedAt?: string };
    customer?: { name?: string; phone?: string; address?: string };
    inspectionStatus: string;
    latestInspectionId?: string | { _id: string; status: string; summary?: string; recommendedAction?: string };
    latestClaimId?: string;
}

export interface Frame {
    frameId: string;
    timestampSec: number;
    brightness?: number;
    sharpness?: number;
    quality: string;
}

export interface Media {
    _id: string;
    type: "outbound" | "return";
    status: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
    metadata?: { durationSec?: number; width?: number; height?: number; codec?: string };
    frames: Frame[];
    quality?: { darkFrameRatio?: number; blurryFrameRatio?: number; maxTimestampGapSec?: number; continuous?: boolean };
    processingError?: string;
    capture?: { scanMethod: string; manualEntry?: boolean; captureMethod: "recorded" | "file"; scannedAt?: string };
    fileUrl: string;
}

export interface Evidence {
    frameId: string;
    type: "outbound" | "return";
    timestampSec: number | null;
}

export interface Finding {
    id: string;
    category: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
    confidence: number;
    certainty: "observed" | "uncertain";
    description: string;
    outboundObservation: string | null;
    returnObservation: string | null;
    evidence: Evidence[];
}

export interface ValidationCheck {
    name: string;
    evidenceType?: string;
    status: "pass" | "fail" | "warn" | "pending";
    detail: string;
}

export interface Validation {
    stage: string;
    ok: boolean;
    blocking: boolean;
    checks: ValidationCheck[];
    escalationReasons: Array<{ code: string; message: string; blocking: boolean }>;
}

export interface AnalysisRecord {
    mediaId: string;
    evidenceType: string;
    source: "ai" | "demo";
    model: string | null;
    result: Record<string, unknown> & { overallConfidence: number; uncertaintyNotes: string[] };
    validationNotes: string[];
}

export interface AgentLogEntry {
    at: string;
    attempt?: number;
    iteration?: number;
    kind: string;
    state?: string;
    tool?: string;
    message?: string;
    error?: string;
    durationMs?: number;
}

export interface SegmentInspection {
    segmentId: string;
    evidenceType: string;
    startSec: number;
    endSec: number;
    question: string;
    source: string;
    result: {
        answer: string;
        verdict: "confirmed" | "not_present" | "inconclusive";
        overallConfidence: number;
        observations: Array<{ description: string; certainty: string; frameIds: string[] }>;
    };
}

export interface Inspection {
    _id: string;
    orderId: string;
    status: "pending" | "processing" | "needs_review" | "completed" | "failed";
    workflowState: string;
    attempt: number;
    analysisMode: "real" | "demo";
    planner: string;
    plannerFallback?: boolean;
    stateHistory: Array<{ state: string; at: string; note?: string; attempt?: number }>;
    evidenceValidation?: { initial?: Validation | null; final?: Validation | null };
    outboundAnalysis?: AnalysisRecord;
    returnAnalysis?: AnalysisRecord;
    comparison?: { findings: Finding[]; summary: string; disclaimer: string; unverifiedAttributes: string[] };
    confidence?: { score: number; threshold: number; meetsThreshold: boolean; calibrated: boolean };
    uncertainty: string[];
    frameReferences: Array<{
        frameId: string;
        mediaId: string;
        type: string;
        timestampSec?: number;
        imageUrl: string | null;
    }>;
    segmentInspections?: SegmentInspection[];
    budgetUsage?: { aiRequests: number; segmentInspections: number; framesAnalyzed: number };
    escalation?: { required: boolean; blocking: boolean; reasons: string[] };
    reviewTask?: {
        status?: string;
        reason?: string;
        reasons?: string[];
        requiredAction?: string;
        resolutionNote?: string;
    };
    summary?: string;
    agentNarrative?: string;
    recommendedAction?: string;
    claimId?: string;
    agentLog: AgentLogEntry[];
    error?: string;
    createdAt: string;
    finishedAt?: string;
}

export interface Claim {
    _id: string;
    orderId: string;
    inspectionId: string;
    status: string;
    summary: string;
    findings: Finding[];
    uncertaintyNotes: string[];
    aiGenerated: boolean;
    analysisMode: "real" | "demo";
    redaction?: {
        textRedactions?: number;
        framesBlurred?: number;
        fullyAnonymized?: boolean;
        privacyReviewRequired?: boolean;
        notes?: string[];
    };
    approval?: { decision?: string; reason?: string; decidedAt?: string; finalDetermination?: string };
    history: Array<{ at: string; by: string; from?: string; to: string; reason?: string }>;
    reportUrl: string | null;
    updatedAt: string;
}
