export class TimeoutError extends Error {
    constructor(label: string, ms: number) {
        super(`${label} timed out after ${ms} ms`);
        this.name = "TimeoutError";
    }
}

/** Race a promise against a timer. The timer is always cleared. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
