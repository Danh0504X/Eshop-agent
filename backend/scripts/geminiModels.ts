/**
 * Lists the Gemini models available to GEMINI_API_KEY, so GEMINI_VISION_MODEL / GEMINI_PLANNER_MODEL
 * can be set to a model that actually exists for this key.
 *
 *   npm run gemini:models
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("GEMINI_API_KEY is not set in backend/.env");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
const pager = await ai.models.list();
const rows: string[] = [];
for await (const model of pager) {
    const actions = model.supportedActions ?? [];
    if (!actions.includes("generateContent")) continue;
    rows.push(`${(model.name ?? "").replace(/^models\//, "").padEnd(40)} ${model.displayName ?? ""}`);
}
console.info(rows.sort().join("\n"));
console.info(`\n${rows.length} model(s) support generateContent.`);
console.info(
    `Configured: vision=${process.env.GEMINI_VISION_MODEL ?? "gemini-3.8-flash"}, planner=${process.env.GEMINI_PLANNER_MODEL ?? "gemini-3.8-flash"}`,
);
