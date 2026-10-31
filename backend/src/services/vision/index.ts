import { env } from "../../config/env";
import { DemoVisionProvider } from "./demoVisionProvider";
import { GeminiVisionProvider } from "./geminiVisionProvider";
import type { VisionProvider } from "./types";

let provider: VisionProvider | undefined;

const createProvider = (): VisionProvider =>
    env.activeProvider === "gemini" ? new GeminiVisionProvider() : new DemoVisionProvider();

export const getVisionProvider = (): VisionProvider => {
    provider ??= createProvider();
    return provider;
};

/** Test hook: inject a deterministic provider (or reset with undefined). */
export const setVisionProvider = (next: VisionProvider | undefined): void => {
    provider = next;
};

export type { VisionProvider, VisionRequest, VisionResponse } from "./types";
