import { runInspection } from "../agent/fixitAgent";
import { env } from "../config/env";
import { Inspection } from "../models/Inspection";
import { Order } from "../models/Order";
import { errorMessage } from "../utils/errors";
import { logger } from "../utils/logger";

type Runner = (inspectionId: string) => Promise<unknown>;

/**
 * Minimal in-process job queue so HTTP requests never wait for video processing or AI calls.
 * Clients poll GET /api/inspections/:id. Job state lives in MongoDB, so a restart is recoverable
 * (see recoverInterruptedInspections). Swap for a durable queue (BullMQ, SQS) when running several instances.
 */
export class InspectionQueue {
    private readonly waiting: string[] = [];
    private readonly running = new Set<string>();
    private paused = false;
    private idleResolvers: Array<() => void> = [];

    constructor(
        private readonly runner: Runner,
        private readonly concurrency: () => number,
    ) {}

    enqueue(inspectionId: string): void {
        if (this.running.has(inspectionId) || this.waiting.includes(inspectionId)) return;
        this.waiting.push(inspectionId);
        this.pump();
    }

    get size(): { waiting: number; running: number } {
        return { waiting: this.waiting.length, running: this.running.size };
    }

    /** Test hook: hold jobs in the queue. */
    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
        this.pump();
    }

    /** Resolves when no job is waiting or running. */
    onIdle(): Promise<void> {
        if (this.running.size === 0 && (this.waiting.length === 0 || this.paused)) return Promise.resolve();
        return new Promise((resolve) => this.idleResolvers.push(resolve));
    }

    private pump(): void {
        while (!this.paused && this.running.size < this.concurrency() && this.waiting.length > 0) {
            const id = this.waiting.shift()!;
            this.running.add(id);
            this.runner(id)
                .catch((error) =>
                    logger.error("Inspection job crashed", { inspectionId: id, error: errorMessage(error) }),
                )
                .finally(() => {
                    this.running.delete(id);
                    this.pump();
                    if (this.running.size === 0 && this.waiting.length === 0) {
                        const resolvers = this.idleResolvers;
                        this.idleResolvers = [];
                        resolvers.forEach((resolve) => resolve());
                    }
                });
        }
    }
}

export const inspectionQueue = new InspectionQueue(
    (id) => runInspection(id),
    () => env.INSPECTION_CONCURRENCY,
);

/**
 * On startup: jobs that were mid-run when the process stopped are marked failed (safe to retry),
 * and jobs that never started are queued again.
 */
export const recoverInterruptedInspections = async (queue: InspectionQueue = inspectionQueue) => {
    const interrupted = await Inspection.find({ status: "processing" });
    for (const inspection of interrupted) {
        inspection.set({
            status: "failed",
            workflowState: "FAILED",
            error: "Interrupted by a server restart. Retry the inspection.",
            recommendedAction: "Retry the inspection.",
            finishedAt: new Date(),
        });
        inspection.agentLog.push({
            kind: "error",
            message: "Interrupted by a server restart",
            attempt: inspection.attempt,
        });
        await inspection.save();
        await Order.updateOne({ _id: inspection.orderRef }, { $set: { inspectionStatus: "failed" } });
    }
    const pending = await Inspection.find({ status: "pending" }).select("_id");
    for (const p of pending) queue.enqueue(p.id);
    if (interrupted.length || pending.length) {
        logger.info("Recovered inspections after restart", { failed: interrupted.length, requeued: pending.length });
    }
    return { failed: interrupted.length, requeued: pending.length };
};
