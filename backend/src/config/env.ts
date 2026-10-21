import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const bool = (def: boolean) =>
    z
        .enum(["true", "false", "1", "0"])
        .optional()
        .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const EnvSchema = z
    .object({
        NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
        PORT: z.coerce.number().int().positive().default(4000),
        MONGODB_URI: z.string().min(1, "MONGODB_URI is required, e.g. mongodb://127.0.0.1:27017/fixit"),
        CLIENT_URL: z.string().default("http://localhost:5173"),

        JWT_SECRET: z
            .string()
            .min(
                32,
                "JWT_SECRET must be at least 32 characters (generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\")",
            ),
        JWT_EXPIRES_IN: z.string().default("8h"),

        DEMO_MODE: bool(false),
        AI_PROVIDER: z.enum(["gemini", "anthropic", "demo"]).default("gemini"),
        GEMINI_API_KEY: z.string().optional(),
        // Configurable because Gemini model availability changes; run `npm run gemini:models` to list yours.
        GEMINI_VISION_MODEL: z.string().default("gemini-3.8-flash"),
        GEMINI_PLANNER_MODEL: z.string().default("gemini-3.8-flash"),
        // Verified on gemini-3.8-flash: LOW, MEDIUM, HIGH accepted; MINIMAL rejected (400). Unset = model default.
        GEMINI_THINKING_LEVEL: z.preprocess(
            (v) => (v === "" ? undefined : v),
            z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
        ),
        // Transport-level backoff for 429/503 only (full jitter, honours Google's RetryInfo).
        AI_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
        AI_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
        AI_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
        // Legacy Anthropic settings, kept until the Gemini migration is verified end to end.
        AI_API_KEY: z.string().optional(),
        AI_MODEL: z.string().default("claude-opus-5-5"),
        AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
        // Per HTTP attempt; shortened automatically to fit the remaining tool/inspection budget.
        AI_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
        AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
        AI_REFUSAL_FALLBACK: bool(true),
        AGENT_PLANNER: z.enum(["llm", "deterministic"]).default("llm"),
        AGENT_MAX_ITERATIONS: z.coerce.number().int().min(3).max(50).default(20),
        AGENT_TIMEOUT_MS: z.coerce
            .number()
            .int()
            .positive()
            .default(15 * 60_000),
        AGENT_TOOL_TIMEOUT_MS: z.coerce
            .number()
            .int()
            .positive()
            .default(5 * 60_000),
        AGENT_MAX_TOOL_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
        MAX_FRAMES_PER_ANALYSIS: z.coerce.number().int().min(1).max(20).default(8),

        UPLOAD_DIR: z.string().default("./uploads"),
        MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().default(200),
        MAX_VIDEO_DURATION_SEC: z.coerce.number().positive().default(600),
        MIN_VIDEO_DURATION_SEC: z.coerce.number().nonnegative().default(2),
        FRAMES_PER_VIDEO: z.coerce.number().int().min(2).max(30).default(8),
        FFMPEG_PATH: z.string().optional(),
        FFPROBE_PATH: z.string().optional(),
        FFMPEG_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

        CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
        HIGH_VALUE_THRESHOLD: z.coerce.number().nonnegative().default(500),
        REQUIRE_VISIBLE_ORDER_ID: bool(true),
        MIN_FRAME_BRIGHTNESS: z.coerce.number().min(0).max(255).default(40),
        MIN_FRAME_SHARPNESS: z.coerce.number().nonnegative().default(15),
        MAX_BAD_FRAME_RATIO: z.coerce.number().min(0).max(1).default(0.5),
        MAX_TIMESTAMP_GAP_SEC: z.coerce.number().positive().default(2),

        RATE_LIMIT_INSPECTIONS_PER_15MIN: z.coerce.number().int().positive().default(20),
        INSPECTION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
        RETENTION_DAYS: z.coerce.number().int().positive().default(180),
        RETENTION_SWEEP_HOURS: z.coerce.number().nonnegative().default(0),
        LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .superRefine((env, ctx) => {
        if (!env.DEMO_MODE && env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
            ctx.addIssue({
                code: "custom",
                path: ["GEMINI_API_KEY"],
                message:
                    "GEMINI_API_KEY is required when AI_PROVIDER=gemini and DEMO_MODE=false. Create a key at https://aistudio.google.com, or set DEMO_MODE=true to run with predefined (non-AI) demo results.",
            });
        }
        if (!env.DEMO_MODE && env.AI_PROVIDER === "anthropic" && !env.AI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
            ctx.addIssue({
                code: "custom",
                path: ["AI_API_KEY"],
                message:
                    "AI_API_KEY is required when AI_PROVIDER=anthropic and DEMO_MODE=false. Set AI_API_KEY, or set DEMO_MODE=true to run with predefined (non-AI) demo results.",
            });
        }
        if (env.AI_TIMEOUT_MS >= env.AGENT_TOOL_TIMEOUT_MS) {
            ctx.addIssue({
                code: "custom",
                path: ["AI_TIMEOUT_MS"],
                message:
                    "AI_TIMEOUT_MS must be lower than AGENT_TOOL_TIMEOUT_MS so a slow AI request cannot consume a whole tool budget.",
            });
        }
        if (env.AGENT_TOOL_TIMEOUT_MS > env.AGENT_TIMEOUT_MS) {
            ctx.addIssue({
                code: "custom",
                path: ["AGENT_TOOL_TIMEOUT_MS"],
                message: "AGENT_TOOL_TIMEOUT_MS must not exceed AGENT_TIMEOUT_MS (the whole inspection budget).",
            });
        }
        if (env.NODE_ENV === "production" && env.DEMO_MODE) {
            ctx.addIssue({
                code: "custom",
                path: ["DEMO_MODE"],
                message: "DEMO_MODE must not be enabled in production.",
            });
        }
    });

export type AppConfig = z.infer<typeof EnvSchema> & {
    IS_PRODUCTION: boolean;
    uploadDirAbs: string;
    /** Effective analysis mode: "demo" whenever DEMO_MODE is on or AI_PROVIDER=demo. */
    aiMode: "real" | "demo";
    /** Which real provider is active (null in demo mode). */
    activeProvider: "gemini" | "anthropic" | null;
};

/** Model names in use, for health checks and logs. Never includes credentials. */
export const activeModels = (config: AppConfig): { vision: string; planner: string } | null => {
    if (config.activeProvider === "gemini")
        return { vision: config.GEMINI_VISION_MODEL, planner: config.GEMINI_PLANNER_MODEL };
    if (config.activeProvider === "anthropic") return { vision: config.AI_MODEL, planner: config.AI_MODEL };
    return null;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
    const parsed = EnvSchema.safeParse(source);
    if (!parsed.success) {
        const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
        throw new Error(`Invalid configuration. Fix your .env file (see .env.example):\n${lines.join("\n")}`);
    }
    const values = parsed.data;
    const demo = values.DEMO_MODE || values.AI_PROVIDER === "demo";
    return {
        ...values,
        AI_API_KEY: values.AI_API_KEY ?? source.ANTHROPIC_API_KEY,
        IS_PRODUCTION: values.NODE_ENV === "production",
        uploadDirAbs: path.resolve(values.UPLOAD_DIR),
        aiMode: demo ? "demo" : "real",
        activeProvider: demo ? null : (values.AI_PROVIDER as "gemini" | "anthropic"),
    };
}

// Validated once at startup; a missing or invalid key stops the process with an actionable message.
export const env: AppConfig = loadConfig();

/** Test hook: override configuration values in place so every importer sees them. */
export function overrideEnv(overrides: Partial<AppConfig>): AppConfig {
    return Object.assign(env, overrides);
}
