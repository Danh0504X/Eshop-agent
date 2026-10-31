import { describe, expect, it } from "vitest";
import { activeModels, loadConfig } from "../src/config/env";

const base = {
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1/x",
    JWT_SECRET: "x".repeat(40),
} as NodeJS.ProcessEnv;

describe("AI provider configuration", () => {
    it("defaults to Gemini and requires GEMINI_API_KEY outside demo mode", () => {
        expect(() => loadConfig({ ...base, DEMO_MODE: "false" })).toThrow(/GEMINI_API_KEY is required/);
    });

    it("does not require any AI key in demo mode and reports no active provider", () => {
        const config = loadConfig({ ...base, DEMO_MODE: "true" });
        expect(config.aiMode).toBe("demo");
        expect(config.activeProvider).toBeNull();
        expect(activeModels(config)).toBeNull();
    });

    it("uses the configured Gemini models when a key is present", () => {
        const config = loadConfig({
            ...base,
            DEMO_MODE: "false",
            GEMINI_API_KEY: "test-key",
            GEMINI_VISION_MODEL: "vision-model-x",
            GEMINI_PLANNER_MODEL: "planner-model-y",
        });
        expect(config.activeProvider).toBe("gemini");
        expect(activeModels(config)).toEqual({ vision: "vision-model-x", planner: "planner-model-y" });
    });

    it("rejects a provider that is no longer supported", () => {
        expect(() => loadConfig({ ...base, DEMO_MODE: "true", AI_PROVIDER: "anthropic" })).toThrow(/AI_PROVIDER/);
    });

    it("rejects time settings where one AI request could exceed a tool or the inspection budget", () => {
        expect(() =>
            loadConfig({ ...base, DEMO_MODE: "true", AI_TIMEOUT_MS: "300000", AGENT_TOOL_TIMEOUT_MS: "300000" }),
        ).toThrow(/AI_TIMEOUT_MS must be lower than AGENT_TOOL_TIMEOUT_MS/);
        expect(() =>
            loadConfig({ ...base, DEMO_MODE: "true", AGENT_TOOL_TIMEOUT_MS: "1000000", AGENT_TIMEOUT_MS: "900000" }),
        ).toThrow(/AGENT_TOOL_TIMEOUT_MS must not exceed AGENT_TIMEOUT_MS/);
        const ok = loadConfig({ ...base, DEMO_MODE: "true" });
        expect(ok.AI_TIMEOUT_MS).toBe(180_000);
        expect(ok.AI_TIMEOUT_MS).toBeLessThan(ok.AGENT_TOOL_TIMEOUT_MS);
    });

    it("accepts only verified thinking levels and treats an empty value as unset", () => {
        expect(
            loadConfig({ ...base, DEMO_MODE: "true", GEMINI_THINKING_LEVEL: "" }).GEMINI_THINKING_LEVEL,
        ).toBeUndefined();
        expect(loadConfig({ ...base, DEMO_MODE: "true", GEMINI_THINKING_LEVEL: "LOW" }).GEMINI_THINKING_LEVEL).toBe(
            "LOW",
        );
        expect(() => loadConfig({ ...base, DEMO_MODE: "true", GEMINI_THINKING_LEVEL: "MINIMAL" })).toThrow();
    });
});
