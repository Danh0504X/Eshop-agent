import { env } from "../../config/env";
import { AnthropicVisionProvider } from "./anthropicVisionProvider";
import { DemoVisionProvider } from "./demoVisionProvider";
import type { VisionProvider } from "./types";

let provider: VisionProvider | undefined;

export const getVisionProvider = (): VisionProvider => {
    provider ??= env.aiMode === "demo" ? new DemoVisionProvider() : new AnthropicVisionProvider();
    return provider;
};

/** Test hook: inject a deterministic provider (or reset with undefined). */
export const setVisionProvider = (next: VisionProvider | undefined): void => {
    provider = next;
};

export type { VisionProvider, VisionRequest, VisionResponse } from "./types";
