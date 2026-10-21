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

    it("no longer needs Anthropic credentials for the default provider", () => {
        const config = loadConfig({ ...base, DEMO_MODE: "false", GEMINI_API_KEY: "k" });
        expect(config.AI_API_KEY).toBeUndefined();
        expect(config.aiMode).toBe("real");
    });
});
