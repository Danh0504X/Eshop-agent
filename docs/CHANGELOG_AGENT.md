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

---

## Demo support — readable agent trace on the server console

- **Files changed:** `backend/src/config/env.ts`, `backend/.env.example`, `backend/src/agent/fixitAgent.ts`, `backend/src/agent/toolRegistry.ts`, `backend/src/services/ai/gemini.ts`, `backend/package.json`
- **Files added:** `backend/src/agent/agentTrace.ts`, `backend/scripts/inspectOrder.ts`, `backend/tests/agentTrace.test.ts`
- **Previous behavior:** the agent's steps were only visible in `inspection.agentLog` (UI / API / Compass); the server console showed HTTP lines only.
- **New behavior:** each inspection prints a line-by-line trace prefixed with the order ID and elapsed time:
  - `START` line with analysis mode (DEMO DATA / REAL gemini + model), planner and time budget;
  - every planner decision `#n [STATE] planner=… -> tool` with the LLM's rationale (`why: …`), marked `(fallback)` after a fallback;
  - every tool result `OK`/`FAIL` with a per-tool summary: frames and quality per video, each video's analysis (product, quantity, colour, model, accessories, packaging, identifiers, image conditions, confidence), comparison findings with frame IDs and timestamps, validation reasons (BLOCKING/advisory), claim and review requests;
  - every Gemini request: model, number of frame images, per-attempt timeout, reply time, token usage and attempts, backoff retries and failures;
  - `GUARDRAIL` / `ERROR` lines and a final `RESULT` line (status, executionLabel, plannerUsed, fallback, claim, why human review, next action).
  - Controlled by `AGENT_TRACE` (default `true`, always silent under tests). It is a view only; `agentLog` and the audit log remain the record.
  - `npm run demo:inspect -- <orderId>` runs an inspection from the command line (as the shop owner) and shows the trace without the UI.
- **Compatibility impact:** none; no logic changed.
- **Tests executed:** typecheck OK; `npm test` 134 passed, 2 skipped. New tests assert the trace content for a mismatch inspection, a missing-evidence escalation, and a Gemini planner run with timing, failure and fallback. `SHOW_TRACE=1` prints a sample.
- **Suggested Git commit:** `feat(agent): readable console trace of the inspection workflow for demos`

---

## Phase 4 — Non-destructive targeted frame extraction

- **Files changed:** `backend/src/services/videoProcessingService.ts`, `backend/src/models/MediaEvidence.ts`, `backend/src/services/visionService.ts`, `backend/src/config/env.ts`, `backend/.env.example`
- **Files added:** `backend/tests/segmentFrames.test.ts`
- **Previous behavior:** frames could only be sampled evenly across the whole video (8 per video). `extractFrames(force)` deleted all existing frames, so re-extraction after an analysis would have silently invalidated cited frame IDs.
- **New behavior:**
  - `extractSegmentFrames(mediaId, { startSec, endSec, count, inspectionId, question })` extracts extra frames from one time range of a processed video. **Append-only**: frames get unique IDs (`RET-S1-01`, `OUT-S2-03`), are stored under `…/segments/<S#>/`, and are appended atomically with a `segments[]` provenance record (range, frame IDs, inspection, question, time). Baseline frames and earlier segments are never modified or deleted. An identical range returns the existing frames (`cached: true`).
  - Limits: `0 ≤ start < end ≤ duration`, span ≤ `MAX_SEGMENT_SECONDS` (10), frames ≤ `MAX_FRAMES_PER_SEGMENT` (6); violations are non-retryable `VALIDATION_ERROR`s. A failed segment extraction cleans up its files and never marks the video as failed.
  - Each frame carries `origin: "initial" | "segment"` (+ `segmentId`). Baseline extraction and the initial `analyze_item` use baseline frames only.
  - **Defect fixed:** `extractFrames(force)` now keeps segment frames and is refused (`INVALID_STATE`) once an inspection analysis or a claim cites frames of that video.
- **Reason:** groundwork for the adaptive re-inspection loop (Phase 6) without invalidating existing evidence references.
- **Compatibility impact:** existing frames without `origin` are treated as baseline. No API or agent changes; the frame image endpoint serves segment frames unchanged (same access checks).
- **Tests executed:** typecheck OK; `npm test` 142 passed, 2 skipped; build OK. New tests (real FFmpeg): unique IDs and timestamps inside the range, baseline untouched, provenance recorded, identical request cached, S2 numbering, six invalid/oversized ranges rejected without side effects, baseline extraction required, force keeps segments, force refused when cited, initial analysis ignores segment frames, segment frame served with shop isolation.
- **Real API test:** not applicable (no AI calls in this phase).
- **Suggested Git commit:** `feat(video): support non-destructive targeted frame extraction`

---

## Phase 6a — Product condition in the vision schema and comparison

- **Files changed:** `backend/src/agent/schemas.ts`, `backend/src/agent/prompts.ts`, `backend/src/services/comparisonService.ts`, `backend/src/services/vision/demoVisionProvider.ts`, `backend/src/agent/agentTrace.ts`, `backend/src/agent/tools/analyzeItem.ts`, `backend/tests/vision.test.ts`
- **Files added:** `backend/tests/productCondition.test.ts`
- **Previous behavior:** the analysis described product type, colour, model, quantity, accessories and packaging, but not the product's own physical condition; a cracked or scratched returned product could not become a finding.
- **New behavior:** each item has `condition { status, damage[{kind, severity, description, certainty, frameIds}], frameIds }`. Normalisation drops damage when the product is not visible and downgrades damage without valid frame IDs to `uncertain`. The comparison adds category `product_condition_change`: observed damage in the return that was not present in an observed outbound becomes a finding (crack/broken/missing part = HIGH, other major = MEDIUM, minor = LOW) whose description states that the recordings cannot show when or how it occurred; otherwise the condition is listed as not verifiable. Demo scenarios `product_scratch` and `needs_closer_look` added.
- **Compatibility impact:** stored analyses without `condition` still compare (treated as not verifiable).
- **Suggested Git commit:** `feat(vision): add product condition to analysis and comparison`

## Phase 6b-1 — Segment vision inspection

- **Files changed:** `backend/src/services/vision/types.ts`, `backend/src/services/vision/geminiVisionProvider.ts`, `backend/src/services/vision/demoVisionProvider.ts`, `backend/src/services/visionService.ts`, `backend/src/agent/schemas.ts`, `backend/src/agent/prompts.ts`
- **Files added:** `backend/tests/segmentVision.test.ts`
- **New behavior:** `VisionProvider.inspectSegment` answers one specific question about a segment's frames with a structured result (`verdict confirmed | not_present | inconclusive`, grounded observations, image conditions, confidence). A `confirmed` verdict without a grounded observation becomes `inconclusive`. `analyzeEvidence(..., { extraFrameIds })` can include requested segment frames in a re-analysis; unknown frame IDs are rejected.
- **Suggested Git commit:** `feat(vision): add focused segment inspection to vision providers`

## Phase 6b-2 / 6c — Bounded adaptive re-inspection loop

- **Files changed:** `backend/src/agent/agentState.ts`, `backend/src/agent/fixitAgent.ts`, `backend/src/agent/tools/analyzeItem.ts`, `backend/src/agent/tools/compareItems.ts`, `backend/src/agent/tools/index.ts`, `backend/src/agent/planners/geminiPlanner.ts`, `backend/src/agent/prompts.ts`, `backend/src/agent/agentTrace.ts`, `backend/src/models/Inspection.ts`, `backend/src/services/inspectionService.ts`, `backend/src/utils/errors.ts`, `backend/src/config/env.ts`, `backend/.env.example`, `backend/scripts/seed.ts`, `backend/tests/agentTools.test.ts`, `frontend/src/types.ts`, `frontend/src/components/InspectionResults.tsx`
- **Files added:** `backend/src/agent/tools/inspectVideoSegment.ts`, `backend/tests/adaptiveLoop.test.ts`
- **Previous behavior:** a strictly linear pass; an unclear attribute could only end in "not verifiable" or human review.
- **New behavior:**
  - New planner tool `inspect_video_segment {evidenceType, startSeconds, endSeconds, question, frameCount?}` (allowed in ITEM_ANALYSIS, COMPARISON, VERIFICATION, ADDITIONAL_INSPECTION). It extracts segment frames (Phase 4), asks the vision model the question, stores a `segmentInspections[]` record and moves to the new state `ADDITIONAL_INSPECTION`.
  - **New evidence invalidates verification:** after a segment inspection, re-analysis or re-comparison the final validation is cleared, and `build_claim_pack` is not allowed in ADDITIONAL_INSPECTION; the agent must run `compare_items` and `validate_evidence` again before a claim.
  - `analyze_item { includeSegmentFrames: true }` re-analyses a video with its unseen segment frames, only in ADDITIONAL_INSPECTION. The replaced analysis is kept in `analysisHistory`, so earlier frame references remain valid.
  - Budgets, separate from tool retries: `MAX_SEGMENT_INSPECTIONS` (3), `MAX_REANALYSES_PER_VIDEO` (1), `MAX_TOTAL_FRAMES_ANALYZED` (40), `MAX_AI_REQUESTS_PER_INSPECTION` (16, planner turns + vision calls). Exceeding one returns non-retryable `BUDGET_EXHAUSTED`; when the AI request budget is used up the planner stops and guardrails hand over to a human. Usage is stored in `budgetUsage` and shown to the planner in `agentState.budgetRemaining`.
  - Repeating a segment (same range, or ≥80% overlap with the same question) returns `DUPLICATE_SEGMENT`; a different segment has its own retry bucket.
  - Agent prompt explains when to re-inspect; the console trace shows segment verdicts, observations and remaining budget, and marks RE-ANALYSIS; the UI lists segment inspections and budget usage; retrying an inspection resets segments, history and budget.
  - Seed order `ORD-008` (`needs_closer_look`) demonstrates the loop with demo vision and the Gemini planner.
- **Compatibility impact:** the deterministic planner never calls the new tool, so its behaviour is unchanged. Planner tool count is now 9.
- **Tests executed:** typecheck OK; `npm test` 161 passed, 2 skipped; backend and frontend build OK. New tests (scripted Gemini planner + demo vision, no network): full loop ending in a HIGH `product_condition_change` claim citing `RET-S1-02/03`; claim refused right after new evidence; planner stopped by the AI budget; duplicate vs different segments; segment and re-analysis budgets; re-analysis rules; baseline frames intact and verification invalidated.
- **Real API test:** not run (free-tier quota).
- **Suggested Git commit:** `feat(agent): bounded adaptive re-inspection loop with budgets`
