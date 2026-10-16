import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globalSetup: ["tests/setup/globalSetup.ts"],
        setupFiles: ["tests/setup/env.ts"],
        testTimeout: 60_000,
        hookTimeout: 120_000,
        include: ["tests/**/*.test.ts"],
    },
});
