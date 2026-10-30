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

---

## Scan-first redesign B1 — Remove monetary fields and refund tracking

- **Files changed:** `backend/src/models/Order.ts`, `backend/src/models/Claim.ts`, `backend/src/validators/schemas.ts`, `backend/src/config/env.ts`, `backend/.env.example`, `backend/src/services/evidenceValidationService.ts`, `backend/src/services/reviewService.ts`, `backend/src/services/claimService.ts`, `backend/src/services/claimReviewService.ts`, `backend/src/services/reportService.ts`, `backend/src/controllers/claim.controller.ts`, `backend/src/routes/claimRoute.ts`, `backend/src/docs/openapi.ts`, `backend/src/agent/agentState.ts`, `backend/src/agent/agentTrace.ts`, `backend/src/agent/fixitAgent.ts`, `backend/src/agent/prompts.ts`, `backend/src/agent/tools/index.ts`, `backend/src/agent/tools/types.ts`, `backend/src/agent/tools/lookupOrder.ts`, `backend/src/agent/tools/notifyHuman.ts`, `backend/scripts/seed.ts`, tests (`helpers`, `agentTools`, `claimApi`, `claimPack`, `evidenceValidation`, `fixitAgent`, `foundation`, `geminiPlanner`, `inspectionApi`, `openapi`)
- **Files removed:** `backend/src/agent/tools/trackRefund.ts`
- **Previous behavior:** orders required `declaredValue` (and `currency`); a value at or above `HIGH_VALUE_THRESHOLD` (500, compared without regard to currency) added the advisory `HIGH_VALUE_ORDER`, so the inspection ended in `needs_review`. Owners recorded requested and actual refund amounts with `POST /api/claims/:id/refund` (tool `track_refund`, hidden from the planner), which flagged shortfalls.
- **New behavior:**
  - The inspection compares the product only. Orders have no `declaredValue` or `currency`; `POST /api/orders` silently drops those keys if a client still sends them.
  - `HIGH_VALUE_ORDER` and `HIGH_VALUE_THRESHOLD` are gone. The remaining advisory escalation is `INSTRUCTION_TEXT_IN_FOOTAGE`; the planner prompt now says to call `notify_human` when final verification reports advisory reasons.
  - Refund tracking is removed: no endpoint, no tool, no `currency` / `requestedCompensation` / `actualRefund` / `refund` on claims. The tool registry has 9 tools, all planner-visible.
  - `lookup_order`, the console trace and the PDF report no longer show a declared value.
- **Compatibility impact:** existing MongoDB documents keep the old fields; Mongoose ignores them (`npm run seed -- --reset` gives clean demo data). `HIGH_VALUE_THRESHOLD` in an existing `.env` is ignored. The old `frontend/` refund form now receives 404 until its minimal update. Required scenario #9 (refund shortfall) is intentionally dropped.
- **Tests executed:** typecheck OK; `npm test` 158 passed, 2 skipped (161 before: the 3 refund tests were removed). Tests that relied on high-value orders now use `useAdvisoryDemoProvider()` (demo vision plus instruction-like text) and still cover claim + advisory review task, closing the advisory review on a claim decision, and refusing a retry while a draft claim is undecided. The PDF privacy test's positive control is now the product model. Build OK.
- **Real API test:** not applicable (no AI behaviour changed).
- **Suggested Git commit:** `refactor(orders): remove declared value, high-value rule and refund tracking`

---

## Scan-first redesign B2 — Stop reading the tracking code from the video

- **Files changed:** `backend/src/agent/schemas.ts`, `backend/src/agent/tools/analyzeItem.ts`, `backend/src/agent/tools/validateEvidence.ts`, `backend/src/agent/agentTrace.ts`, `backend/src/services/evidenceValidationService.ts`, `backend/src/services/reviewService.ts`, `backend/src/services/visionService.ts`, `backend/src/services/vision/types.ts`, `backend/src/services/vision/demoVisionProvider.ts`, `backend/src/config/env.ts`, `backend/.env.example`, tests (`fixtures`, `claimPack`, `evidenceValidation`, `fixitAgent`, `geminiVision`, `vision`)
- **Previous behavior:** the vision model transcribed order IDs and tracking codes from labels (`visibleIdentifiers`). Final verification blocked with `ORDER_ID_NOT_VISIBLE` when a video showed no legible code (`REQUIRE_VISIBLE_ORDER_ID=true`) and with `ORDER_ID_MISMATCH` when it showed a different one.
- **New behavior:**
  - `visibleIdentifiers` is removed from the vision schema (and therefore from the JSON schema sent to Gemini), from the planner's analysis summary and from the console trace. The model no longer reads order identifiers.
  - `ORDER_ID_NOT_VISIBLE` and `REQUIRE_VISIBLE_ORDER_ID` are gone. `ORDER_ID_MISMATCH` remains only as the backend check that a linked video was recorded for this order and shop.
  - Demo scenarios `missing_identifier` and `mismatched_identifier` are removed; the demo context no longer carries order identifiers.
  - Binding a video to its order moves to the scan step (B3/B4).
- **Compatibility impact:** stored analyses that still contain `visibleIdentifiers` are ignored by the code. `REQUIRE_VISIBLE_ORDER_ID` in an existing `.env` is ignored. Privacy flags (`framesWithPeople`, `framesWithPersonalData`) are unchanged, so PDF frame blurring still works.
- **Tests executed:** typecheck OK; `npm test` 156 passed, 2 skipped (158 before: the two "no visible order identifier" tests were removed). Both "case 8" tests now link a video recorded for another order and expect a blocking `ORDER_ID_MISMATCH`; the agent version also asserts that no AI call is made. The claim-pack refusal test uses `low_confidence` as its blocking case. The Gemini request test asserts the schema no longer contains `visibleIdentifiers`. Build OK.
- **Real API test:** not run.
- **Suggested Git commit:** `refactor(vision): stop reading order identifiers from footage`

---

## Scan-first redesign B3 — Label scans and orders created from them

- **Files changed:** `backend/src/models/Order.ts`, `backend/src/models/index.ts`, `backend/src/validators/schemas.ts`, `backend/src/services/orderService.ts`, `backend/src/controllers/order.controller.ts`, `backend/src/routes/api.ts`, `backend/src/docs/openapi.ts`, `backend/src/config/env.ts`, `backend/.env.example`, `backend/tests/foundation.test.ts`, `backend/tests/openapi.test.ts`
- **Files added:** `backend/src/models/ScanSession.ts`, `backend/src/services/scanService.ts`, `backend/src/controllers/scan.controller.ts`, `backend/src/routes/scanRoute.ts`, `backend/tests/scanFlow.test.ts`
- **Previous behavior:** `POST /api/orders` took a client-chosen `orderId` and a typed `trackingCode`; nothing tied the order to a physical label, and the same tracking code could be used by several orders.
- **New behavior:**
  - `POST /api/scans {code, purpose: packing|return, method: camera|image_file|hand_scanner|manual}` records a label scan with a server timestamp and an expiry (`SCAN_SESSION_TTL_MINUTES`, default 30). The code must look like a tracking code (letters, digits, `.`, `_`, `-`; max 64), so a scanned URL or text QR is rejected.
    - **packing:** refused with 409 if the shop already has an order for that code; the response names the order only when the caller may open it.
    - **return:** finds the order within the caller's shop and warehouses (404 other shop, 403 other warehouse) and returns it (customer data only to owners).
  - `POST /api/orders` now requires `scanId` (a packing scan made by the caller, unexpired) and no longer accepts `orderId` or `trackingCode`. The tracking code comes from the scan; the order ID is generated as `ORD-YYMMDD-XXXX` (server local date, characters without 0/O/1/I/L, regenerated on the rare collision). One tracking code belongs to one order per shop.
  - The scan is claimed atomically before the order is written, so one scan never creates two orders; if creation fails (for example a warehouse the caller is not assigned to) the scan is released and can be used again.
  - Orders store `trackingScan {scanId, method, manualEntry, scannedAt, scannedBy}`; `manualEntry` is true when the code was typed because the label could not be scanned. It is a label only and does not change the inspection result.
  - Scans are audited (`scan.record`); `order.create` audits now include the tracking code and scan method.
- **Compatibility impact:** the old `frontend/` order form (which sends `orderId`/`trackingCode` without a scan) now gets 400 until its minimal update. Seed and existing orders are unchanged (no `trackingScan`). The tracking-code uniqueness rule is enforced by the service, not by a unique index, so existing databases need no index migration.
- **Tests executed:** typecheck OK; `npm test` 166 passed, 2 skipped (10 new in `scanFlow.test.ts`: order ID format; packing scan; rejected codes, purposes, methods and anonymous calls; existing code with and without visibility; return-scan lookup and scope; scanned tracking code and generated ID despite client-supplied identifiers; manual entry; concurrent use of one scan; wrong purpose, expired, someone else's and unknown scans; code taken after the scan and scan released after a failed creation). `foundation` order tests now create orders from scans. Build OK.
- **Real API test:** not applicable (no AI calls).
- **Suggested Git commit:** `feat(orders): create orders from label scans with generated order IDs`

---

## Scan-first redesign B4 — Every evidence video is bound to a label scan

- **Files changed:** `backend/src/models/MediaEvidence.ts`, `backend/src/models/ScanSession.ts`, `backend/src/validators/schemas.ts`, `backend/src/services/mediaService.ts`, `backend/src/services/scanService.ts`, `backend/src/services/evidenceValidationService.ts`, `backend/src/services/reviewService.ts`, `backend/src/services/ffmpegService.ts`, `backend/src/controllers/scan.controller.ts`, `backend/src/routes/api.ts`, `backend/src/docs/openapi.ts`, `backend/src/config/env.ts`, `backend/.env.example`, `backend/scripts/seed.ts`, tests (`setup/env`, `helpers`, `evidenceValidation`, `fixitAgent`, `foundation`, `inspectionApi`, `scanFlow`)
- **Files added:** `backend/tests/evidenceCapture.test.ts`
- **Previous behavior:** any authorised user could upload a video file for an order; nothing recorded when or how it was captured, and the AI used to read the label to tie it to the order (removed in B2).
- **New behavior:**
  - `POST /api/orders/:orderId/media` requires `scanId` and `captureMethod` (`recorded` | `file`), optionally `recordingStartedAt` / `recordingEndedAt`. The scan must be the uploader's own, unexpired, of this order's tracking code, of the matching kind (packing scan for outbound, return scan for return), and unused for a video; it is claimed atomically and released again if the upload fails.
  - `captureMethod=file` (attach an existing file) is accepted only when the new `ALLOW_FILE_EVIDENCE` is true (default false; `.env.example` sets true for local demos). A check that a `captureMethod=recorded` video is not longer than the time since its scan (plus 5 s) is implemented but **temporarily commented out** in `uploadEvidence`, so videos recorded earlier can still be uploaded while the workflow is tried out; the comment explains how to re-enable it.
  - Videos store `capture {scanId, scanMethod, manualEntry, scannedAt, scannedBy, captureMethod, recordingStartedAt?, recordingEndedAt?}`.
  - Evidence validation adds the blocking `EVIDENCE_NOT_SCANNED` for a linked video without a capture record, so such an inspection is escalated before any AI call; the review task asks to scan the label and upload the video again.
  - A packing scan of a tracking code that already has an order now returns that order instead of 409, so its packing video can be added (for example after a failed upload) or replaced. It still cannot create a second order.
  - `probeVideo` falls back to packet timestamps when the container has no duration, as in WebM files written live by a browser `MediaRecorder`. Without this, in-app recordings would fail both the duration check and frame extraction.
  - `GET /api/health` reports `allowFileEvidence`.
  - Seed videos are bound to hand-scanner scans and attached as files; `--reset` also removes scan sessions.
- **Compatibility impact:** videos uploaded before this change have no `capture` and now block inspections with `EVIDENCE_NOT_SCANNED`; run `npm run seed -- --reset` for clean demo data. With `ALLOW_FILE_EVIDENCE` unset, file uploads are refused (set it to true for the old `frontend/` and local demos). The old `frontend/` upload form gets 400 until its minimal update.
- **Tests executed:** typecheck OK; `npm test` 175 passed, 3 skipped (9 new: 7 active in `evidenceCapture.test.ts` covering capture recording, required fields, wrong kind / other label / other user / reused scan, manual entry, file uploads disabled without using up the scan, a long recorded video accepted while the timing check is disabled, and a live WebM without a duration header that uploads and extracts 8 frames; plus `EVIDENCE_NOT_SCANNED` in evidence validation and in the agent, which makes no AI call). The timing-check test is kept as `it.skip` for when the check is re-enabled. Existing upload tests now scan first; test helpers bind fixture videos to a scan unless `scanned: false`. Build OK.
- **Real API test:** not applicable (no AI calls).
- **Suggested Git commit:** `feat(evidence): require a label scan for every evidence upload`

---

## Scan-first redesign F0 — Minimal update of the old demo frontend

- **Files changed:** `frontend/src/types.ts`, `frontend/src/services/api.ts`, `frontend/src/components/CreateOrderForm.tsx`, `frontend/src/components/EvidencePanel.tsx`, `frontend/src/components/ClaimPanel.tsx`, `frontend/src/pages/ClaimsPage.tsx`, `frontend/src/pages/OrdersPage.tsx`
- **Previous behavior:** after B1–B4 the old `frontend/` could no longer create orders (it sent `orderId`, `trackingCode`, `declaredValue`) or upload videos (no scan), and its refund form called a removed endpoint.
- **New behavior:**
  - The order form has no order ID, declared value or currency. Submitting records a packing scan of the typed tracking code (`method: manual`) and creates the order from it; the backend generates the order ID. A code that already has an order is reported instead of creating a duplicate.
  - The evidence form asks for the tracking code printed on the label, records a packing or return scan for it (`manual`) and uploads the file with `captureMethod: file` (requires `ALLOW_FILE_EVIDENCE=true`).
  - Evidence rows show how each video was bound (label scanned or typed by hand; recorded in the app or attached file); the order view marks tracking codes typed by hand.
  - Refund tracking (claim panel and claims list column) and the declared value row are removed.
- **Compatibility impact:** this UI has no scanner, so every order and video it creates is marked as a manual entry. The new `web/` frontend replaces it for the scan-first workflow.
- **Tests executed:** `npm run typecheck`, Prettier and `npm run build` in `frontend/` OK. The request sequences it uses (manual packing scan → create order; packing/return scan → upload with `captureMethod=file`) are covered by the backend API tests. Not clicked through in a browser.
- **Suggested Git commit:** `fix(frontend): adapt the demo UI to scan-bound orders and evidence`

---

## Scan-first redesign W1 — New `web/` frontend: app shell

- **Files added:** `web/package.json`, `web/package-lock.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/.prettierrc`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/lib/{api,auth,health,types}.ts(x)`, `web/src/components/{AppShell,ModeChips,icons,ui}.tsx`, `web/src/pages/{LoginPage,PlaceholderPage}.tsx`
- **What it is:** a separate, production-style UI for the scan-first workflow (the old `frontend/` stays as the demo UI). React 19 + TypeScript + Vite like `frontend/`, plus `react-router` for real URLs. Vietnamese UI, plain CSS with design tokens, inline SVG icons, no UI library. Dev server on port 5174, proxying `/api` to the backend.
- **Behaviour in this step:**
  - Login (Vietnamese errors; dev-only quick-fill for the seeded accounts), token stored under its own key, automatic return to login when the backend rejects the token.
  - Responsive shell: on screens of 900 px and wider, a sidebar with the two main actions (Thêm đơn, Nhận hàng hoàn) and navigation (Đơn hàng, Khiếu nại); below that, a top bar and a bottom tab bar for phones.
  - Always-visible mode chips from `GET /api/health`: "Dữ liệu demo" or "AI thật · Gemini", and "Tải file từ máy (demo)" when `ALLOW_FILE_EVIDENCE` is on; a banner when the backend or its database is unreachable.
  - Routes for orders, new order, order detail, returns and claims exist; their pages are placeholders replaced in the next steps. No agent logs or raw data are shown anywhere.
- **Tests executed:** `npm run typecheck`, Prettier and `npm run build` in `web/` OK. Ran the app against a throwaway in-memory MongoDB seeded with the demo data (backend on 4100 with `DEMO_MODE=true`) and drove it in headless Chrome: login page, real login through the form, orders and returns routes and the 404 page at 1280x800 and 390x844, with no console errors.
- **Suggested Git commit:** `feat(web): scaffold the new frontend with login and responsive app shell`

---

## Scan-first redesign W2 — Label scanner and video recorder in `web/`

- **Files added:** `web/src/lib/barcode.ts`, `web/src/lib/camera.ts`, `web/src/components/LabelScanner.tsx`, `web/src/components/VideoCapture.tsx`, `web/src/pages/DeviceCheckPage.tsx`
- **Files changed:** `web/package.json`, `web/package-lock.json`, `web/vite.config.ts`, `web/src/App.tsx`, `web/src/components/icons.tsx`, `web/src/styles.css`
- **New behavior:**
  - `LabelScanner` reads the tracking code with the camera (rear camera when available) or, when `ALLOW_FILE_EVIDENCE` is on, from an uploaded photo of the label. Decoding uses `barcode-detector` (ZXing-C++ WebAssembly) for Code 128/39/93, ITF, EAN-13, QR and Data Matrix; the `.wasm` is bundled and served by the app, never fetched from a CDN. A camera read is accepted after the same code appears in two consecutive frames; a label with several codes asks the person to pick the tracking number; a value that cannot be a tracking code (for example a URL in a QR code) is rejected with a hint. "Nhãn bị hỏng? Nhập tay" accepts a typed code (same format rule) and reports it as a manual entry. No hand-scanner support (not needed).
  - `VideoCapture` records with the browser camera through `MediaRecorder` (VP8 WebM, or MP4 on Safari), shows a timer, stops automatically at 600 s, and lets the person review, re-record or confirm; recordings shorter than 2 s cannot be confirmed. When `ALLOW_FILE_EVIDENCE` is on it also accepts a video file from the computer. Files are created with the plain MIME type (`video/webm`) the backend accepts.
  - Camera errors (permission denied, no camera, camera in use, non-HTTPS page) get Vietnamese messages and a retry.
  - Development page `/dev/devices` (only routed by the dev server) tries both components without contacting the backend and can download the recording.
  - `npm run dev:https` serves the dev server over HTTPS on the local network (`@vitejs/plugin-basic-ssl`), because phones only allow the camera on HTTPS.
- **Problems found while testing and fixed:** headless Chrome reported `video/webm;codecs=vp9` as supported but produced empty recordings, so VP8 is preferred and an empty recording or a recorder error is reported instead of being handed over; the camera frame is height-capped and centered on wide screens so the controls stay visible.
- **Tests executed:** `npm run typecheck`, Prettier and `npm run build` in `web/` OK. Drove the dev page in headless Chrome against a throwaway in-memory database, with a fake camera fed by a generated Code 128 label: camera scan → `GHN12345678`; uploaded label → same code; label with two barcodes → choice list; URL QR → rejected; manual entry validated. Recorded 3 s with the fake camera: 43 KB VP8 WebM whose container has no duration (`duration=N/A`), which the backend's `probeVideo` measured as 3.2 s and `POST /api/orders/ORD-007/media` accepted with `captureMethod=recorded`. No console errors and no requests outside the app. `npm run dev:https` answered over HTTPS. Not tried on a physical phone or webcam.
- **Suggested Git commit:** `feat(web): add camera label scanner and in-browser video recorder`

---

## Scan-first redesign W3 — "Thêm đơn" (add order) screen in `web/`

- **Files added:** `web/src/pages/NewOrderPage.tsx`
- **Files changed:** `web/src/lib/api.ts`, `web/src/lib/types.ts`, `web/src/App.tsx`, `web/src/components/LabelScanner.tsx`, `web/src/components/icons.tsx`, `web/src/pages/DeviceCheckPage.tsx`, `web/src/styles.css`
- **New behavior:**
  - `/orders/new` is a three-step wizard: (1) scan the shipping label (camera, uploaded photo in demo mode, or flagged manual entry) and record a packing scan; (2) order details with the tracking code filled in and locked ("Quét lại" to rescan), warehouse, product name, quantity, model, colour, SKU, description, accessories as chips, optional customer data; (3) record the packing video (or attach a file in demo mode). The order is created and the video uploaded only at the end, with an upload progress bar; the backend generates the order ID. A done screen links to the order or starts another one.
  - A packing scan of a code that already has an order shows that order: "Mở đơn", and when it has no packing video yet (for example a failed upload), "Quay video đóng gói cho đơn này" goes straight to step 3 for it.
  - If the upload fails after the order was created, the screen says so and offers to rescan the label, which leads back to adding the packing video to that order.
  - API client: `api.scan`, `api.createOrder`, `api.uploadEvidence` (XMLHttpRequest for upload progress). Shared `ScanMethod` type in `lib/types`.
- **Tests executed:** `npm run typecheck`, Prettier and `npm run build` in `web/` OK. Drove the screen in headless Chrome against a throwaway in-memory database: camera scan of a generated Code 128 label → locked code → details with two accessories and a customer name → 3 s recording → order `ORD-261030-JH52` created; the API showed the scanned tracking code, all details, one packing video (`recorded`, `video/webm`, scan `camera`) and no customer data for the employee. Rescanning the same label showed the existing order without the add-video action. A photo of the label of an existing order without video led to adding a packing video from a file (`file` / `image_file`). Phone layout checked at 390x844. No console errors. One earlier run timed out waiting for the confirm button after recording; two later runs passed without warnings and the cause was not identified.
- **Suggested Git commit:** `feat(web): add the scan-first "Thêm đơn" wizard`

---

## Scan-first redesign W3 fix — Clear validation errors in "Thêm đơn"

- **Files changed:** `web/src/lib/api.ts`, `web/src/pages/NewOrderPage.tsx`
- **Problem:** creating an order could fail at the very end with only "Thông tin chưa hợp lệ. Request validation failed". The backend's `warehouseId` accepts only letters without diacritics, digits and `. _ -`, and owner accounts type the warehouse by hand, so values like `Kho Hà Nội` were rejected after the video had already been recorded. The UI ignored the field details the backend returned.
- **New behavior:** step 2 checks the warehouse, product name and quantity before moving on to the video; the warehouse field explains the allowed characters; validation errors from the backend are shown per field in Vietnamese.
- **Tests executed:** `npm run typecheck` and Prettier in `web/` OK. In headless Chrome against a throwaway database, as the owner: `Kho Hà Nội` is stopped at step 2; `kho1` creates the order and uploads the video; a simulated backend validation error shows the field messages. The exact value that caused the reported failure was not confirmed.
- **Suggested Git commit:** `fix(web): explain validation errors and check the warehouse before recording`

---

## Scan-first redesign W4 — Orders list, order detail and "Nhận hàng hoàn" in `web/`

- **Files added:** `web/src/pages/OrdersPage.tsx`, `web/src/pages/OrderDetailPage.tsx`, `web/src/pages/ReturnPage.tsx`, `web/src/components/AuthVideo.tsx`, `web/src/components/wizard.tsx`, `web/src/lib/orderStatus.ts`
- **Files changed:** `web/src/App.tsx`, `web/src/lib/api.ts`, `web/src/lib/types.ts`, `web/src/pages/NewOrderPage.tsx`, `web/src/styles.css`
- **Previous behavior:** "Đơn hàng", order detail and "Nhận hàng hoàn" were placeholder pages.
- **New behavior:**
  - `/orders` lists orders with search by tracking code or order ID, which videos exist and one combined status (Chờ video đóng gói, Chờ hàng hoàn, Chờ kiểm tra, Đang kiểm tra, Cần xem xét, Khớp, Có sai lệch, Kiểm tra lỗi).
  - `/orders/:orderId` shows the order details and plays both videos. Videos are fetched with the auth header and played from an object URL. A missing video links to the screen that adds it.
  - `/returns/new` scans the label with a return scan: an unknown code says no order was found; an order that already has a return video links to the order; otherwise the person records or (demo) attaches the opening video, which is uploaded with progress. An order without a packing video gets a warning but can still receive the return video.
  - The step indicator and progress bar are shared components.
- **Not included:** starting an inspection and showing its result from `web/` (still done in `frontend/`), and replacing an existing return video.
- **Tests executed:** `npm run typecheck`, Prettier and build in `web/` OK. In headless Chrome against a throwaway database, as the owner: 9 orders listed; search finds one and shows an empty state for an unknown code; a detail page plays the packing video; return flow for an unknown code, for an order with a return video, and for `TRK-1004` with a file upload, after which the detail page plays both videos with status "Chờ kiểm tra". Phone layout checked at 390x844. No page errors.
- **Suggested Git commit:** `feat(web): add orders list, order detail and return receiving screens`
