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

---

## Step A — Stability patch: timeouts, backoff and time budget

- **Files changed:** `backend/src/config/env.ts`, `backend/.env.example`, `backend/src/services/ai/gemini.ts`, `backend/src/services/vision/geminiVisionProvider.ts`, `backend/src/services/vision/types.ts`, `backend/src/services/visionService.ts`, `backend/src/agent/schemas.ts`, `backend/src/agent/agentState.ts`, `backend/src/agent/toolRegistry.ts`, `backend/src/agent/fixitAgent.ts`, `backend/src/agent/tools/analyzeItem.ts`, tests (`geminiVision`, `agentTools`, `fixitAgent`, `config`, `integration/gemini.real`)
- **Files added:** `backend/src/utils/retry.ts`, `backend/tests/retry.test.ts`
- **Previous behavior:**
  - `AI_TIMEOUT_MS` = 120 s; a single real vision call was measured at 94–120+ s.
  - No backoff: 429/503 surfaced immediately and the agent retried the tool at once (up to 3 times, no wait).
  - Each tool had a fixed 5-minute timeout and the planner a separate fixed timeout, independent of how much of the 15-minute inspection budget was left.
- **New behavior:**
  - `AI_TIMEOUT_MS` default **180 s**, validated to be **< `AGENT_TOOL_TIMEOUT_MS` (300 s) ≤ `AGENT_TIMEOUT_MS` (900 s)**.
  - **Transport retries** (`utils/retry.ts`, used by `callGemini`): only **429 and 503**, exponential backoff with full jitter (`AI_RETRY_BASE_DELAY_MS` 2 s, cap `AI_RETRY_MAX_DELAY_MS` 30 s, `AI_RETRY_MAX_ATTEMPTS` 3 incl. the first request). Google's `RetryInfo.retryDelay` (or a "retry in Ns" hint) is honoured as a minimum wait. If the error persists, it is returned as **final** (not retryable) so the agent escalates instead of compounding retries.
  - **Three separate budgets, by design:** (1) transport retries of one HTTP request (above); (2) agent tool retries for a failed tool call (`AGENT_MAX_TOOL_RETRIES`, unchanged); (3) deliberate additional inspections (Phase 6, separate budget). Attempts are recorded as `usage.apiAttempts`.
  - **Deadline propagation:** the agent context carries `deadline` (inspection start + `AGENT_TIMEOUT_MS`). Each tool runs until `min(deadline, tool start + AGENT_TOOL_TIMEOUT_MS)`; `analyze_item` passes that to the provider, which shortens each request's timeout to fit and never starts a backoff wait that would end past it (a request needs ≥ 5 s left or it fails fast as final). The planner is also bounded by the remaining inspection time.
  - `GEMINI_THINKING_LEVEL` (optional): **measured on `gemini-3.8-flash`** — `LOW`, `MEDIUM`, `HIGH` accepted; `MINIMAL` rejected with 400. Only the three accepted values are allowed; empty = model default.
- **Measurement that shaped the design:** a trivial one-word prompt took 50–72 s at every thinking level (thinking tokens 101–214). Latency is dominated by server-side queueing under high demand, not by thinking, so timeouts/backoff/budget matter more than the thinking level.
- **Compatibility impact:** 429/503 that persist after backoff are now final (escalate) instead of retryable at the tool level. Existing `.env` files that still contain `AI_TIMEOUT_MS=120000` keep the old value — update it to `180000`.
- **Tests executed:** typecheck OK; `npm test` 121 passed, 1 skipped; build OK. New: backoff growth/jitter/cap, Retry-After honoured, non-retryable not retried, attempt limit, deadline never overrun, server delay longer than budget, RetryInfo parsing, 503-then-success, per-request timeout shortened to the budget, fail-fast without calling Gemini, thinking level sent/omitted, tool cut off at the inspection deadline, tool not started after the budget, deadline passed to the provider, hanging planner bounded and escalated, config consistency.
- **Real API test:** `npm run test:gemini` passed with `AI_TIMEOUT_MS=180000` (94 s, `gemini-3.8-flash`). With the local `.env` value of 120000 the same test timed out at 120 s.
- **Known limitations:** Free-tier latency (≈ 1–2 min per call) makes a full inspection several minutes long; the per-request timeout and the 15-minute budget bound it but do not make it faster.
- **Suggested Git commit:** `fix(ai): improve Gemini timeout handling and retry backoff`

---

## Phase 3 — Gemini Planner (function calling)

- **Files changed:** `backend/src/agent/fixitAgent.ts`, `backend/src/agent/toolRegistry.ts`, `backend/src/agent/agentState.ts`, `backend/src/agent/prompts.ts`, `backend/src/agent/planners/types.ts`, `backend/src/agent/planners/deterministicPlanner.ts`, `backend/src/agent/planners/llmPlanner.ts`, `backend/src/models/Inspection.ts`, `backend/tests/fixitAgent.test.ts`
- **Files added:** `backend/src/agent/planners/geminiPlanner.ts`, `backend/tests/geminiPlanner.test.ts`, `backend/tests/integration/geminiPlanner.real.test.ts`
- **Files removed:** none (the Anthropic planner stays until Phase 7).
- **Previous behavior:** `AGENT_PLANNER=llm` always used the Anthropic planner; with only a Gemini key it failed and fell back. Planner log entries did not say which planner decided or why.
- **New behavior:**
  - `GeminiPlanner` uses Gemini function calling: tools are declared from the registry (`plannerToolSpecs`, same Zod schemas the registry validates; `track_refund` stays hidden) as `functionDeclarations` with `parametersJsonSchema`, `functionCallingConfig.mode = AUTO`.
  - **History:** each model turn (`candidates[0].content`) is appended verbatim, including thought signatures; the planner never creates, edits or drops them. Each tool result goes back as a `functionResponse` with the same name and (when Gemini supplied one) the same id, in call order, plus an `agentState` snapshot (workflow state, allowed tools, evidence collected, pending escalation codes, remaining seconds). No customer data.
  - Gemini decides from results; the prompt was rewritten from a step script to a goal + constraints, and asks for a one-sentence rationale before each call.
  - Planner selection: `inspection.planner = llm` → Gemini planner when `AI_PROVIDER=gemini` (Anthropic planner only when `AI_PROVIDER=anthropic`); demo mode stays deterministic.
  - **Decision trace** on every agent log entry: `planner` (`gemini | anthropic | deterministic`), `selectedTools`, `rationale`, `fallbackUsed`, `reason`; tool-call entries carry the planner that requested them and the tool result/error. A final `HUMAN_REVIEW` entry records why a human was brought in.
  - **Provenance:** inspection gains `plannerUsed` and `executionLabel` (`REAL_GEMINI | REAL_ANTHROPIC | DEMO | DETERMINISTIC_FALLBACK`). After a fallback every decision is logged as `planner=deterministic`, `fallbackUsed=true`, so it is never presented as an LLM decision.
  - Unchanged: tool registry authorisation and Zod validation, state permissions, escalation gate, guardrails, human review, DB read-back for the final status.
- **Compatibility impact:** `plannerToolDefinitions()` (Anthropic shape) now derives from `plannerToolSpecs()`; `Planner` gains a `name`. Existing inspections without the new fields read as before.
- **Tests executed:** typecheck OK; `npm test` 130 passed, 2 skipped (opt-in real-API tests); build OK. New unit tests (scripted Gemini client): full inspection from Gemini's choices with verbatim model-turn replay (thought signature) and matching functionResponses for parallel calls; a different evidence situation leading Gemini to escalate; invalid arguments and empty tool names fed back as errors; out-of-order claim rejected; timeout / empty / safety-blocked turns fall back visibly; decision trace fields; post-fallback labelling; automatic Gemini planner selection.
- **Real API test:** `tests/integration/geminiPlanner.real.test.ts` passed (≈ 271 s, 4 planner calls, `gemini-3.8-flash`). Gemini chose `lookup_order` → `validate_evidence` → read `EVIDENCE_MISSING` → `notify_human` → finished; `plannerFallback=false`, `executionLabel=REAL_GEMINI`. Multi-turn function calling worked with thought signatures preserved; tool schemas using `minLength`, `maxLength`, `pattern`, `enum` were accepted.
- **Known limitations:**
  - Only the missing-evidence path was exercised against the real API. A full real run (≈ 9 planner calls + 2 vision calls) would take several minutes on the free tier and has not been run yet.
  - Each planner call takes about a minute on the free tier, so `AGENT_PLANNER=llm` makes inspections slow; the 15-minute budget bounds it.
  - The planner's final narrative is free text from the model; it is stored separately (`agentNarrative`) and never drives decisions.
- **Suggested Git commit:** `feat(agent): migrate LLM planner to Gemini function calling`
