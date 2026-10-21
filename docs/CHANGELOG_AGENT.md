# Agent changelog — Gemini migration and adaptive inspection

Each phase is one small, tested unit. Test counts are from actual runs of `npm test` and `npm run build` in `backend/`.

---

## Phase 1 — Gemini SDK and configuration

- **Files changed:** `backend/src/config/env.ts`, `backend/.env.example`, `backend/src/routes/api.ts`, `backend/src/server.ts`, `backend/package.json`, `backend/package-lock.json`
- **Files added:** `backend/scripts/geminiModels.ts`, `backend/tests/config.test.ts`
- **Previous behavior:** `AI_PROVIDER` accepted `anthropic | demo` (default `anthropic`); real mode required an Anthropic key; health endpoint reported `AI_MODEL`.
- **New behavior:**
  - `AI_PROVIDER` accepts `gemini | anthropic | demo`, default **`gemini`**.
  - New keys: `GEMINI_API_KEY`, `GEMINI_VISION_MODEL`, `GEMINI_PLANNER_MODEL` (both default `gemini-3.8-flash`; configurable because model availability changes).
  - Default model verified with a real key: `gemini-2.5-flash` is listed by `models.list` but returns 404 "no longer available to new users"; Google names `gemini-3.8-flash` as the replacement (`gemini-flash-latest` currently resolves to it).
  - Real mode with `AI_PROVIDER=gemini` fails at startup with an actionable message if `GEMINI_API_KEY` is missing. Demo mode needs no key.
  - Derived `env.activeProvider` (`gemini | anthropic | null`) and `activeModels(env)`.
  - `GET /api/health` adds `aiProvider` and `plannerModel`; `aiModel` now reports the vision model (field kept for frontend compatibility).
  - `npm run gemini:models` lists models available to the configured key.
- **Reason:** Gemini becomes the default provider; models must be configurable rather than hard-coded.
- **Compatibility impact:** Existing `.env` files with `AI_PROVIDER=anthropic` keep working. Anthropic variables remain until Phase 7.
- **Tests executed:** typecheck OK; `npm test` 94/94 passed; build OK.
- **Known limitations:** model availability can change again; `npm run gemini:models` lists models, but listing does not guarantee access (see above).
- **Suggested Git commit:** `chore(ai): configure Google Gemini SDK and environment variables`

---

## Phase 2 — Gemini Vision Provider

- **Files changed:** `backend/src/services/vision/index.ts`, `backend/src/services/vision/types.ts`, `backend/src/services/vision/anthropicVisionProvider.ts`, `backend/src/services/visionService.ts`, `backend/src/agent/schemas.ts`, `backend/package.json`
- **Files added:** `backend/src/services/ai/gemini.ts`, `backend/src/services/vision/geminiVisionProvider.ts`, `backend/src/services/vision/errors.ts`, `backend/tests/geminiVision.test.ts`, `backend/tests/integration/gemini.real.test.ts`
- **Previous behavior:** real vision analysis used the Anthropic SDK only; `visionService` imported `aiError` from the Anthropic provider file.
- **New behavior:**
  - `GeminiVisionProvider` sends each selected frame as `inlineData` (JPEG) preceded by its label (`Frame RET-05 at t=3.4s`), plus the product checklist. System prompt unchanged (`VISION_SYSTEM_PROMPT`).
  - Structured output via `responseMimeType: "application/json"` + `responseJsonSchema` generated from the existing `VisionAnalysisSchema` (schema unchanged). Output is parsed and validated with Zod in the provider **and** again in `visionService` (unchanged).
  - Error classification (`services/ai/gemini.ts`): 429 / 5xx / timeout / network / malformed JSON / truncation → retryable; safety blocks, prompt blocks, 400, 401/403, 404 (unknown model) → not retryable. SDK-level retries are off; the tool registry keeps owning bounded retries.
  - Provider-reported token usage is carried into `AnalysisRecord.usage` (for cost measurement).
  - Factory selects `Gemini | Anthropic | Demo` from `env.activeProvider`.
  - `aiError` moved to `services/vision/errors.ts` (re-exported from the Anthropic file until Phase 7).
- **Reason:** replace Anthropic for vision while keeping the schema, validation and downstream contracts identical.
- **Compatibility impact:** none for downstream services; `AnalysisRecord` gains an optional `usage` field.
- **Tests executed:** typecheck OK; `npm test` 100 passed, 1 skipped (the opt-in real-API test); build OK.
- **Known limitations:**
  - Mocked tests only verify the request/response contract, **not visual accuracy**.
  - **Real Gemini call verified** (`npm run test:gemini`, model `gemini-3.8-flash`, synthetic test-pattern frames): the JSON schema is accepted and the output passes Zod validation with valid frame citations. This proves the contract only, not accuracy on real products.
  - Observed latency: one vision call took ≈ 110 s end to end in the passing run, close to `AI_TIMEOUT_MS` = 120 s. Earlier attempts got `503 UNAVAILABLE` ("high demand"), which is classified as retryable. Latency tuning (thinking level, timeout) is still open.
  - 404 errors now include Google's own message, which names the replacement model when one is retired.
  - Until Phase 3, `AGENT_PLANNER=llm` still uses the Anthropic planner; with only a Gemini key it fails and falls back to the deterministic planner (logged). Use `AGENT_PLANNER=deterministic` until Phase 3 lands.
- **Suggested Git commit:** `feat(vision): integrate Gemini for structured video frame analysis`
