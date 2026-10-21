import { env } from "../../config/env";
import { AnthropicVisionProvider } from "./anthropicVisionProvider";
import { DemoVisionProvider } from "./demoVisionProvider";
import { GeminiVisionProvider } from "./geminiVisionProvider";
import type { VisionProvider } from "./types";

let provider: VisionProvider | undefined;

const createProvider = (): VisionProvider => {
    switch (env.activeProvider) {
        case "gemini":
            return new GeminiVisionProvider();
        case "anthropic":
            return new AnthropicVisionProvider();
        default:
            return new DemoVisionProvider();
    }
};

export const getVisionProvider = (): VisionProvider => {
    provider ??= createProvider();
    return provider;
};

/** Test hook: inject a deterministic provider (or reset with undefined). */
export const setVisionProvider = (next: VisionProvider | undefined): void => {
    provider = next;
};

export type { VisionProvider, VisionRequest, VisionResponse } from "./types";
