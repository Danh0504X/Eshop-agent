import { AuditLog } from "../models/AuditLog";
import { logger, scrubSecrets } from "../utils/logger";

export interface AuditEntry {
    action: string;
    actorType: "user" | "agent" | "system";
    actorId?: string;
    shopId?: string;
    orderId?: string;
    inspectionId?: string;
    claimId?: string;
    mediaId?: string;
    outcome?: "success" | "failure" | "denied";
    details?: Record<string, unknown>;
}

/**
 * Persist an audit record. Secrets are scrubbed from `details`.
 * Audit failures are logged but never break the business operation that triggered them.
 */
export const recordAudit = async (entry: AuditEntry): Promise<void> => {
    try {
        await AuditLog.create({ ...entry, details: entry.details ? scrubSecrets(entry.details) : undefined });
    } catch (error) {
        logger.error("Failed to write audit log", { action: entry.action, error: (error as Error).message });
    }
};
