import { env } from "../config/env";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /(api[_-]?key|secret|password|token|authorization)/i;

/** Strip anything that looks like a credential before it reaches a log line. */
export function scrubSecrets(value: unknown, depth = 0): unknown {
    if (depth > 6 || value === null || typeof value !== "object") {
        if (typeof value === "string") return value.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
        return value;
    }
    if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : scrubSecrets(v, depth + 1);
    }
    return out;
}

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
    if (env.NODE_ENV === "test" && level !== "error") return;
    const threshold: Level = env.LOG_LEVEL;
    if (ORDER[level] < ORDER[threshold]) return;
    const line = JSON.stringify({
        t: new Date().toISOString(),
        level,
        msg,
        ...(meta ? (scrubSecrets(meta) as object) : {}),
    });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const logger = {
    debug: (m: string, meta?: Record<string, unknown>) => log("debug", m, meta),
    info: (m: string, meta?: Record<string, unknown>) => log("info", m, meta),
    warn: (m: string, meta?: Record<string, unknown>) => log("warn", m, meta),
    error: (m: string, meta?: Record<string, unknown>) => log("error", m, meta),
};
