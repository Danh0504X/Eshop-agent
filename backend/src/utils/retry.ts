/**
 * Bounded retry with exponential backoff and full jitter, for transient provider errors (429/503).
 * This is transport-level retrying of one request. It is separate from the agent's tool-level retry
 * budget (a failed tool call) and from deliberate additional inspections the agent chooses to make.
 */

export interface RetryDecision {
    retry: boolean;
    /** Server-requested wait (Retry-After / RetryInfo), honoured as a minimum delay. */
    retryAfterMs?: number;
}

export interface RetryOptions {
    /** Total attempts including the first one. */
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    /** Epoch ms. No wait is started that would end after this instant. */
    deadline?: number;
    classify: (error: unknown) => RetryDecision;
    onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
}

export class RetryExhaustedError extends Error {
    constructor(
        readonly cause: unknown,
        readonly attempts: number,
        readonly reason: "max_attempts" | "deadline",
    ) {
        super(
            `Gave up after ${attempts} attempt(s) (${reason === "deadline" ? "time budget exhausted" : "retry limit reached"})`,
        );
        this.name = "RetryExhaustedError";
    }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full jitter: a random delay in [0, min(maxDelay, base · 2^(attempt-1))]. */
export const backoffDelay = (
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number,
    random: () => number = Math.random,
) => Math.round(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));

/**
 * Run `fn` until it succeeds, the error is not retryable, attempts run out, or the deadline would be passed.
 * Non-retryable errors are rethrown unchanged; exhausted retries throw RetryExhaustedError wrapping the last error.
 */
export const retryWithBackoff = async <T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions,
): Promise<{ value: T; attempts: number }> => {
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    for (let attempt = 1; ; attempt++) {
        try {
            return { value: await fn(attempt), attempts: attempt };
        } catch (error) {
            const decision = options.classify(error);
            if (!decision.retry) throw error;
            if (attempt >= options.maxAttempts) throw new RetryExhaustedError(error, attempt, "max_attempts");
            const delayMs = Math.max(
                backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs, options.random),
                decision.retryAfterMs ?? 0,
            );
            if (options.deadline !== undefined && now() + delayMs >= options.deadline) {
                throw new RetryExhaustedError(error, attempt, "deadline");
            }
            options.onRetry?.({ attempt, delayMs, error });
            await sleep(delayMs);
        }
    }
};
