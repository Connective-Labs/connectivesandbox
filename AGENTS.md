# AGENTS.md — Connective Sandbox

Multi-tenant AI workflow console. Authoritative spec: Notion page
"Connective Sandbox — GLM Build Instructions" (`292f699a-4023-469d-8ebd-54167f9e8c13`).
Seven phase gates; each phase commits and pushes its working branch and stops
for captain approval. Never push to `main`.

## Stack

React + Vite + TypeScript (strict), Tailwind v4, shadcn/ui (new-york, slate),
Zod. Supabase arrives in Phase 4 — do not add it before then. Do not add
dependencies beyond the standard scaffold set without a captain decision.

## Architectural invariants (enforced from phase 1 onward)

1. **No model emits UI at runtime.** An admin LLM emits a JSON `WorkflowSpec`
   validated against the Zod schema in `src/engine/schema.ts`; the fixed
   component registry (`src/engine/registry.ts`) renders it.
2. **`src/engine/` is pure.** It imports nothing from `src/data/`, Supabase,
   or any network library — ever. It contains only types, schema, registry,
   runner. The runner receives a `JudgeProvider` by injection.
3. **All data access goes through `src/data/adapters/`.** Components never
   call Supabase directly. Adapters hit the real backend exclusively — the
   Phase 1–3 fixtures were deleted in Phase 7 and nothing imports them.
4. **`src/engine/types.ts` is FROZEN.** Written verbatim in phase 1; never
   edit it in any later phase. Sole captain-approved exception (module waves
   1+2, 2026-09-30): `photo_slot` + `follow_up_card` joined the intake union;
   `triage_verdict`, `quote_panel`, `escalation_card`, `thread_preview`,
   `status_queue`, `alert_feed`, `kpi_tiles`, `pipeline_tracker` joined the
   dashboard union. No further edits without a captain decision.
5. **No secret, model key, or `service_role` key ever reaches the browser.**
6. **A judge never returns free text.** `JudgeAnswer.value` is
   `string | boolean | number` and, for choice judges, must be one of the
   judge's `options`, with a full `probabilities` distribution.

## Commands

- `npm run build` — type-check + production build (must stay green)
- `npm run dev` / `npm run preview` / `npm run lint`

## Phase 5 — auth & gateway decisions

- **No new npm dependencies.** Both the adapters and the Edge Functions use
  plain `fetch`; supabase-js was rejected as unnecessary machinery (the browser
  never talks to PostgREST directly — everything rides the gateway).
- **Same-origin function calls.** The session cookie is `SameSite=Strict`, so
  the browser must send it same-site: adapters call the relative path
  `/functions/v1/…`, and the host proxies it to the Supabase project (Vite
  dev/preview proxy here; an equivalent same-origin rewrite in production).
  Cookie: `cs_session`, `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age
  86400`.
- **JWT claims.** The spec's `{ role: 'admin' | 'client', client_id }` is
  carried as `app_role` because PostgREST reserves `role` for the database
  role; the JWT sets `role: 'authenticated'` plus `app_role`/`client_id`, so
  RLS policies accept it directly. Signed HS256 with the platform JWT secret:
  this project's hosted runtime does not inject `SUPABASE_JWT_SECRET`, so the
  Edge secret `JWT_SECRET` (set in Phase 4 for this purpose) is used, with a
  `SUPABASE_JWT_SECRET` fallback for portability.
- **Rate limiters** were REMOVED in polish 3 (captain decision): the
  four-digit gate is now CLIENT-SIDE. The browser validates the code against
  the code → {role, client_id} map served publicly by the `auth-codes`
  function (admin code from the `ADMIN_ACCESS_CODE` secret, client codes from
  the `clients` table) — PUBLIC BY DESIGN for a sandbox, see the README
  trade-off section. `auth-code` POST now simply mints {role, client_id} from
  the trusted browser request: no validation, no `auth_attempts` writes, no
  limiters. The `auth_attempts` table remains in the schema, unused.
- **Login gate warm path (polish 3).** Login code-splits the destination
  screens (React.lazy in App.tsx), preloads both chunks plus the code map on
  mount, and after a code match mints the session while warming the
  destination's data behind the gate (`src/data/prefetch.ts` viaCache read
  through the adapters; any mutation calls `invalidateReads()`). The matched
  screen renders dimmed/blurred/non-interactive behind the login overlay, so
  the swap on success is instant.
- **Gateway split.** `auth-code` issues sessions (POST), resolves them (GET),
  and clears them (DELETE). `admin-api` verifies the cookie server-side and
  performs admin CRUD with `service_role` internally; client sessions may only
  read their own workflows (mirroring the RLS scope, enforced server-side).
- **CORS** is an explicit allow-list (localhost dev ports + the
  `ALLOWED_ORIGINS` Edge secret); no wildcard with credentials.

## Phase 6 — workflow execution decisions

- **Judge providers live in `src/services/judge/`** (factory + `jev` (live,
  Codiv openjev via /v1/systemone), `laya_modal`/`laya_space` (implemented per
  the Laya contract, UNTESTED — no live endpoint), `mock`). Providers take
  plain config objects; only the Edge Functions resolve credentials from
  secrets. All judges in a workflow are batched into ONE provider request;
  state budget is 512 tokens/question enforced by a deterministic compressor
  (`compress.ts`, event logged). Any unparseable answer throws
  `JudgeParseError` → `run-workflow` writes confidence-0 `decisions` rows
  carrying the raw response and surfaces the failure in the UI. There is NO
  code path that substitutes an LLM judgement for a judge.
- **Deno import discipline.** Deno requires explicit `.ts` extensions on
  value imports; relative value imports in `src/services/**` carry them
  (type-only imports may stay extensionless — they are erased). Edge Functions
  import the pure engine (`src/engine/schema.ts`, `runner.ts`) directly.
- **admin-chat import map.** `supabase/functions/import_map.json` maps
  `zod` → `npm:zod` so the Edge Function can validate specs against the one
  frozen Zod schema; wired via `[functions.admin-chat] import_map` in
  config.toml. The validation/self-correction loop runs server-side (max 3
  rounds); the spec is only returned once it validates, else the validation
  error is surfaced.
- **GLM parameters (verified against current Z.ai docs).** Endpoint
  `https://api.z.ai/api/paas/v4/chat/completions`; model `glm-5.3-flash`,
  temperature 1, top_p 0.95, `thinking: {type: 'enabled'}` +
  `reasoning_effort` (GLM-5.3 series accepts low/high/max).
  **DEVIATION from brief:** `reasoning_effort: 'max'` makes a single builder
  turn think for ~150s (measured live), which kills the hosted Edge Function
  (wall-clock limit → WORKER_RESOURCE_LIMIT). Default is 'high' (same turn
  ~58s, full content); override with the `GLM_REASONING_EFFORT` secret.
  `max_tokens` is generous (16384 default) — with reasoning on, small budgets
  are consumed by thinking before any content is emitted.
- **Edge Function wall-clock budget.** admin-chat does its validation loop
  internally then streams the final reply as SSE (`{delta}` chunks, a
  `{done:true}` metadata event, `data: [DONE]`); client-chat relays GLM's SSE
  after filtering reasoning frames. Persist assistant messages BEFORE closing
  the stream — post-close work races isolate recycling (bug hit in e2e).
- **Builder chat persistence.** One `sessions` row with `kind='builder'` per
  workflow (migration 20250201…); the per-workflow admin chat history is real
  `messages` rows. Run sessions use `kind='run'`.
- **Decision ledger is the only dashboard source.** `run-workflow` writes one
  `decisions` row per judge (always, with latency_ms). Client workspace runs
  call the Edge Function; the admin live preview stays on the local fixture
  provider (never consumes judge calls or writes ledger rows — the only
  sanctioned exception). Monitoring tiles are computed from decisions rows;
  unknown metric names fall back to the decision count. Usage totals derive
  from decisions (runs = sessions with ≥1 decision row); `usage/totals` is
  readable by clients scoped to their own rows.
- **Storage flow.** `artifact-api` verifies the client JWT, checks session
  ownership, then issues a signed upload URL (path `{client_id}/{session_id}/
  {artifact_id}-{filename}`, artifact row written at sign time). Client PUTs
  the raw body; downloads use short-lived signed URLs (client chat attaches
  them as `image_url` blocks — never base64).
- **Rotated secrets this phase:** `ADMIN_ACCESS_CODE` (no plaintext existed
  after Phase 5), and set `ZAI_API_KEY`. Secrets referenced by name only.

## Polish 4 — chat behaviour & unified intake

- **Everything is the chat window.** `IntakeSurface` renders exactly one chat
  flow (Chat, mounted directly so the flow can carry the other intake
  components as inline cards). `file_upload`/`form`/`button_group`/
  `text_field` render as compact in-chat cards via `variant: 'inline'` on
  `IntakeComponentViewProps` (registry.ts); panel variants remain for
  compatibility. Spec component types are untouched (frozen types.ts).
- **Inline card submissions are chat sends.** A card's `onSubmitted` posts a
  summarised user message through the same send path (live: persist + run +
  stream; preview: mock run + echo), then collapses to a compact sent chip.
  Tray files carry `source` provenance: card-picked files are routed to their
  intake component's slot at send time via `sendChatMessage`'s `filesBySlot`
  so judge state keeps the spec's keying; composer files still ride the chat
  slot. Drag-drop anywhere on the chat panel + paperclip + card button all
  feed the ONE attachment tray.
- **Chat behaviours (shared in `src/components/chat/`):** `useStickToBottom`
  pins the transcript to the newest message on send/stream/history unless the
  user scrolls up; `TypingBubble` (three CSS dots, static "…" under
  `prefers-reduced-motion`) stands in until the first streamed token;
  `Markdown` renders model replies via react-markdown (captain-approved
  dependency #2) with no `rehype-raw`, so output is sanitised by construction
  — styles live in its component map, never as chrome.
- **Tick clipping.** Bubble content uses `break-words
  [overflow-wrap:anywhere]` and the timestamp row `whitespace-nowrap`; the
  bubble must never get `overflow-hidden` (it would clip the ::after tails).
- **Registry chat entry caveat.** Chat is mounted directly by IntakeSurface,
  so its registry entry is a cast; Vite notes the dynamic import is
  ineffective for chunking — expected, keep the entry for registry coverage.

## Phase 7 — production cleanup

- **Fixtures deleted.** `src/data/fixtures/` and `scripts/validate-fixtures.ts`
  are gone (so is the `validate:spec` script). Zero imports remain — the admin
  live preview now uses `mockJudgeProvider` from `src/services/judge/mock.ts`,
  which is behaviourally identical (same canned answers, deterministic
  fallbacks) and is the sanctioned test provider. Preview runs still never
  consume judge calls or write ledger rows.
- **`ADMIN_ACCESS_CODE` rotated this phase.** The Phase 6 value existed
  nowhere retrievable (never recorded in plaintext after `supabase secrets
  set`), so it was rotated. The current value lives in the firstmate config
  store (`/home/macbooklee/firstmate/config/connectivesandbox-admin.env`);
  reference it by NAME only, never print it.

## Polish 5 — guided creation & unmissable admin actions

- **Guided workflow creation.** "New workflow" (header strip, always visible,
  labelled) opens `src/components/admin/RecipePicker.tsx` — one card per named
  recipe from `docs/modules.md` (Photo triage, Document intake review,
  Approval desk) plus "Something else" (plain chat). The list is a single
  typed constant (`RECIPES`); new recipes land there first, then in the
  modules doc. Picking a recipe creates the workflow and pre-fills the builder
  composer with a seed message naming the client and the business pattern;
  bracketed specifics are the only required input. Duplicate-current lives in
  the picker footer.
- **Module design principles** (what qualifies a module: the five tests, six
  constraints, operational loop) are codified in `docs/modules.md`; visual
  mockups of the proposed Wave 1/Wave 2 modules live in `docs/module-mockups.html`.
- **Admin CRUD discoverability.** The New client / New workflow actions were
  icon-only Plus buttons inside a collapsed hover rail — the captain could not
  find them. Now: a 48px action strip under the top bar carries both actions
  as labelled buttons at every viewport; the rail starts pinned open (controlled
  pin state in `CollapsibleRail`); the rail list headers carry labelled
  "+ New client" / "+ New workflow" text buttons as well. Row-level rename/
  delete keep their hover reveal + inline confirms from polish 1.
- **Transcript-ready (design note only).** The `admin-chat` contract must stay
  machine-callable (stateless message list in, streamed reply out) so a future
  live transcriber can drive the same builder without UI changes; recipes +
  the modules catalogue are the constraint layer that makes auto-building
  safe. Recorded in `docs/modules.md`. No functional change.

## Live transcription pipeline (livebuild v2 — the fact-ledger architecture)

- **Facts are the source of truth; specs are compiled projections.** The
  draft brain no longer regenerates a WorkflowSpec from rolling prose (that
  duplicated modules whenever speech restated a requirement). Instead
  `live-facts` classifies transcript into KEYED FACTS appended to
  `transcript_facts`, and pure compilers (`src/engine/compilers.ts`) turn the
  replayed ledger into the exact spec JSON — one element per key, deduped by
  construction. `src/engine/facts.ts` (idempotent replay by key: add-on-
  active demotes to confirm, remove tombstones, remove-after-add wins),
  `src/engine/catalogue.ts` (closed key space, decision sets, thresholds,
  per-key default strings, recipe seeds), `src/engine/compilers.ts`.
  Determinism is asserted by `node scripts/verify-fact-ledger.mjs` (also:
  never-reject strings, fidelity replay, cross-engine parity).
- **Two-stage jev, NO LLM except strings (captain decision).** Stage 1: jev
  screens the ROLLING transcript every ~5s (material_change | minor_change |
  no_change). Stage 2: only on material change, a second jev call extracts
  keyed facts (add/update/confirm/remove over the closed catalogue, the
  decision set, and option facts `judge.decision.options.<opt>`). GLM fills
  string slots for NEWLY created elements only (one call, silent failure —
  catalogue placeholders keep validity). Never in screening/extraction/
  structure.
- **A draft is NEVER rejected (captain decision).** Compilers guarantee Zod
  validity by construction (deterministic non-empty placeholders); on a
  bug-level failure the recipe baseline compiles instead. `live-draft` POST
  was removed (410 → /live-facts); live-draft keeps the draft rail
  (GET/PATCH/DELETE).
- **Server STT engine.** `live-transcribe` (Deepgram batch-chunked) makes
  recording cross-browser: MediaRecorder capture → sequential self-contained
  chunks → text only returns. Both engines sit behind the ONE
  `TranscriptionEngine` interface in `src/data/adapters/transcribe.ts`
  (`chooseEngine()`: server when a `GET /live-transcribe` probe reports
  available — 503 while `DEEPGRAM_API_KEY` is unprovisioned — Web Speech
  fallback). No audio
  stored anywhere. Captions render ONE growing transcript with word-level
  fades; previews animate only the delta (stable element ids + mount
  animations; compiled specs are byte-stable for unchanged state).
- **Durable guards (all anchored on tables, survive isolate recycling).**
  Screen cadence ~5s (`SCREEN_COOLDOWN_SECONDS`, transcript_segments anchor,
  read BEFORE the request's own insert), extraction ~8s
  (`EXTRACT_COOLDOWN_SECONDS`, transcript_facts anchor), draft floor ~10s
  (`DRAFT_COOLDOWN_SECONDS`, spec_drafts anchor), 300-fact session cap, and
  a flush-compile path (`compile_signature`, no jev spend) so a suppressed
  final state still becomes a draft. Suppressions are re-queued client-side,
  never dropped.
- **Durability + RLS.** `transcript_segments`, `transcript_facts` (migration
  20261001000000), and `spec_drafts` follow the Phase 5 gateway pattern: RLS
  enabled, NO policies (default deny) — reachable ONLY via service_role
  inside Edge Functions (isolation test covers transcript_facts). Publishing
  a draft rides the existing publish path (PUT spec, version bump); the draft
  row is then flagged via live-draft PATCH.
- **UI.** Centre column of the admin screen is tabbed: Builder (chat,
  primary path) and Live build (`src/components/admin/LiveBuild.tsx`):
  record control, growing word-level captions, active fact-ledger chips, and
  the numbered draft rail. Publish stays the right-column action on the
  previewed spec — the rep is the UAT gate.
- **Verification.** `supabase/tests/live-transcribe-e2e.sh` drives the
  deployed pipeline headless: scripted discovery call with INTENTIONAL
  repetition (photo requirement 3x, escalation 2x) → each keyed fact ONCE;
  cross-engine parity (sentence-chunked vs 8s-chunked → identical
  structural signature); no duplicate ids in any draft; flush stability;
  publish; gateway isolation. Signatures are RECIPE-SCOPED — always pass the
  same recipe context to GET and POST (workflow_id infers it on both).
  Structural signature (`structural_signature`) excludes GLM strings — use
  it for semantic comparisons.

## Feedback channel (Phase 9 — dual-output client service chat)

- **Surface.** Client workspace gets a Workflow | Feedback toggle; Feedback is
  a WhatsApp-style thread (`FeedbackChat`) with attachments via the existing
  artifact flow. Admin gets an Inbox mode (third centre tab, unread badge on
  the tab, polled quietly — no popups): thread list left, conversation right,
  proposed-draft cards with Test (loads the draft into the existing preview
  sandbox)/Publish/Discard, plus a per-client change log of published
  feedback drafts. Rep replies are stored as `feedback_messages`
  direction='rep'.
- **Planner adapter (recorded decision).** The parallel-AI edit pipeline sits
  behind `SpecPlanner` in `supabase/functions/_shared/planner.ts`:
  `plan({feedback, classification, currentSpec}) → PlannerProposal`
  ({strings, componentOps, thresholdTweaks, summary}). v1 = GLM-5.3-Flash
  (plain fetch, `reasoningEffort: 'low'`); a Claude/other planner slots in by
  adding a branch to `resolvePlanner()` (`PLANNER_ADAPTER` env: 'glm' default,
  'none' disables) with zero caller/UI changes. The proposal is applied
  DETERMINISTICALLY by `applyProposal` (whitelisted string slots computed
  from the current spec, catalogue-only component add/remove, thresholds
  clamped to ±0.1 / review ≥ 0.5 / auto ≤ 0.95 / review < auto) and the
  frozen Zod schema remains the hard gate (deterministic-strings retry).
- **Classification.** `feedback` Edge Function stores the message first, then
  ONE batched openjev call → closed set wording | structure | accuracy |
  feature_request | bug | question (+ accuracy_target judge when
  identifiable, stored as `referenced_judge`). Failure → 'question' +
  `classification_fallback` — the message is never lost. accuracy rows are
  evaluation data, never auto-fixable (the planner may propose only a bounded
  threshold tweak in the draft for rep review).
- **Rate guard.** Planner invocations bounded per client per hour
  (`FEEDBACK_PLANNER_MAX_PER_HOUR`, default 5), counted durably from
  `feedback_messages` (classification in wording/structure in the last hour)
  so it survives isolate recycling; suppressed messages are stored +
  classified, only the draft spend is held back.
- **Durability.** `feedback_messages` (migration 20260929000000) follows the
  gateway pattern: RLS enabled, NO policies (default deny) — client JWTs see
  zero rows directly; the `feedback` function scopes every read by the
  verified cookie with service_role inside. `spec_drafts` gained
  `feedback_message_id`; drafts use source='feedback' and reuse the live-draft
  publish/flag path. Isolation test extended (A, B, claimless JWT all read
  zero feedback rows); `supabase/tests/feedback-e2e.sh` drives the labelled
  classification set (reports accuracy), draft/no-draft split, rate guard,
  inbox flow, publish/discard, and cross-client gateway isolation.

## Polish 6 — render-first live build, e2e self-cleanup, usage strip, skeleton discipline

- **Cadence + render-first strings.** The draft floor is 4s
  (`DRAFT_COOLDOWN_SECONDS`, was 10s); stage 1 stays on the ~5s screen cadence
  and stage 2 on the ~8s extract cadence, so the invocation budget holds.
  `live-facts` NO LONGER awaits the GLM string pass: drafts compile with
  catalogue placeholders and return `strings_pending`. The client renders the
  skeleton immediately, then POSTs `{fill_strings: true}` — that mode runs the
  one GLM call, caches the strings onto the fact rows (so every future compile
  carries them), updates the newest transcript draft's spec IN PLACE, and
  returns the recompiled spec. Admin preview placeholders render draft-styled
  (`DraftSpecProvider` + `SpecText`, catalogue-placeholder detection) and each
  landed string fades in by element id; client surfaces are unaffected.
- **e2e suites self-clean.** All three scripts (`modules-e2e`, `feedback-e2e`,
  `live-transcribe-e2e`) delete their probe clients by NAME PREFIX with the
  service_role key in the EXIT trap (no admin session needed, runs on
  failure), then assert zero rows matching the prefix
  (`__mod_e2e_*`, `__fb_e2e_*`, `__livefacts_e2e_*`). New tests must follow
  this pattern — the captain reviews the live DB.
- **`usage_counter` is a compact stat strip**: small uppercase label,
  tabular-numeral value with `formatCountCompact` unit scaling (1.2k, 3.4M),
  truncating as a last resort — no overflow at any viewport. Reads the
  decisions ledger only (unchanged contract).
- **Skeleton discipline.** `useGraceSkeleton` (in `ui/Primitives`) holds any
  loading skeleton ~300ms minimum so it never flashes; applied to the admin
  rail lists, inbox thread list, live-build draft rail, and the workspace
  loading pane. Motion sweep: draft chips + fact chips (LiveBuild), verdict
  flips (TriageVerdict), queue state chips (StatusQueue) animate with
  framer-motion under the app-wide `reducedMotion="user"` guard.
- **Capabilities guide.** In-product: `src/components/admin/CapabilitiesGuide.tsx`
  (collapsible "What can I build?" card set above the centre tabs). Repo doc:
  `docs/capabilities.md` — keep the two in step when recipes/modules change.

## Hardening 1 — bug sweep + live-build wave parity

- **Builder history window fixed.** `admin-chat` fetched messages ASC with
  `limit 24` — PostgREST applies limit AFTER order, so long conversations fed
  the model the OLDEST rows and hid the newest turn. Now desc + reverse.
- **fill_strings keeps its recipe.** The parallel string pass now sends
  `workflow_id` (recipe inference matches the draft compile — the generic
  recompile that dropped recipe seeds is gone) and feeds the GLM call the
  session's transcript tail instead of an empty context.
- **Feedback planner sees the wave modules.** `_shared/planner.ts` covers all
  intake kinds + addable panels (escalation_card, kpi_tiles, pipeline_tracker,
  status_queue, alert_feed, confidence_meter, analysis, monitoring); wave
  string slots are rewordable everywhere. triage_verdict / quote_panel /
  thread_preview are reword-ONLY (judge-bound, not auto-addable).
  decision_log + usage_counter are ALWAYS-ON — never planner-removable.
  `applyProposal` deep-clones panels (nested rows/lines/alerts mutate in
  place).
- **Live build compiles the waves.** `intake.photo` → keyed `photo_slot`
  (judge-state key `photos`), `intake.files` → generic `file_upload`
  (document-intake), `intake.follow_up` → `follow_up_card`. New judges
  `judge.archetype` / `judge.follow_up` / `judge.price_band` with closed sets;
  new decision sets `route` + `price_band`. `operations-desk` is a REAL
  recipe (queue/alerts/kpi/pipeline/escalation panels) — the approval-desk
  alias is GONE; `normaliseRecipeId('operations-desk')` returns itself.
  Option-fact narrowing (`judge.decision.options.<opt>`) still applies only to
  the decision judge; the new choice judges compile their full closed sets.
- **Shared spec validation.** `extractSpecJson`/`validateSpec` live in
  `_shared/spec-validate.ts` (pure, importable by Edge Functions AND Node).
- **Headless verify layer (no secrets, CI-runnable).**
  `node scripts/verify-fact-ledger.mjs` (13 assertions, wave parity included),
  `node scripts/verify-builder-spec.mjs` (extraction/validation/applier,
  no-mutation guarantee), `node --experimental-strip-types
  scripts/verify-wave-modules.mts`. Run all three after engine changes.
- **Small fixes:** publish syncs the workflow row's `name` from `spec.name`;
  duplicate 4-digit client codes surface an inline error (unique constraint
  swallowed silently before); dead code removed (`appendBuilderMessage`,
  `getUsageSnapshot` + the `/usage/snapshot` route, `fetchLiveLedger`,
  `UsageSnapshot`); README deploy list covers all 11 functions and the full
  secret list; `docs/modules.md` transcript-ready section reflects shipped
  reality.

## Phase 2 — Reusable template library

- **Templates are whole-workflow assets.** `workflow_templates` (migration
  20261002000000) stores the curated spec, `category` (recipe id or 'custom'),
  `version`, lineage (`parent_template_id` chains versions,
  `created_from_workflow_id` records provenance), and `slots` — the
  parameterisation list from `src/engine/templating.ts`. Workflows gain
  `source_template_id` + `source_template_version` (provenance per build).
  Gateway RLS: RLS on, NO policies — service_role inside admin-api only.
- **`src/engine/templating.ts` is the parameterisation layer.** `templateSlots`
  walks EVERY rewordable display string (canonical walk shared with the
  feedback planner — planner's `stringSlots` delegates) plus every judge
  threshold, each with the source value as `example`. `applySlotValues`
  applies rep-edited values deterministically: unknown paths ignored, strings
  length-bounded, thresholds clamp to ±0.1 of the example inside the global
  band (review < auto enforced), input never mutated.
- **Templates keep their curated copy; instantiation is identity-safe.** The
  instantiate form REQUIRES a fresh name/description (defaults never carry
  another client's name); other slots pre-fill from examples and only CHANGED
  values travel. The frozen Zod schema gates every instantiation in admin-api.
- **Curated seeds self-heal.** `GET /admin-api/templates` upserts the four
  recipe baselines compiled from the catalogue (drift → version bump, so
  workflows record which revision they came from). No migration-embedded
  spec JSON — the catalogue stays the single source of truth.
- **admin-api templates resource** (admin-only): list (with usage counts),
  get, save-as-template (`POST /templates {workflow_id, name?, as_version_of?}`),
  instantiate (`POST /templates/:id/instantiate`), delete (curated protected).
  admin-api now imports the engine + Zod — the import map is wired in
  config.toml for it.
- **UI.** RecipePicker gains the Library section (saved templates with
  version + usage; picking opens the grouped slot form —
  `TemplateFlow.tsx`). "Save as template" sits beside Publish
  (`SaveTemplateModal.tsx`, version-of dropdown for lineage). Instantiate
  creates the workflow at version 1 and rides the normal Test/Publish gate.
- **Verify.** `node scripts/verify-builder-spec.mjs` now covers
  `templateSlots` coverage, exact/non-mutating/deterministic application,
  bound-clamping, and a fully-customised Zod-valid round-trip.

## Phase 3 — GLM planning stage (plan-workflow)

- **The planner decides WHAT, never HOW.** `src/engine/plan.ts` holds the
  Zod-validated `WorkflowPlan` (headline, rationale, template choice, module
  sanity list, slot-keyed customisations with a one-line why, open questions)
  and `planToMarkdown` for the transcript card. The model NEVER emits a spec:
  `plan-workflow` compiles the chosen template through `applySlotValues`, so
  only real slot keys apply and the frozen Zod schema gates the result.
- **`plan-workflow` Edge Function** (import_map wired in config.toml):
  admin-only; rate guard counted durably from `spec_drafts` source='plan'
  (`PLAN_MAX_PER_HOUR`, default 10); context = client name + existing
  workflows ("do not duplicate") + up to 8 template candidates WITH slot keys
  (so every customisation names a real slot) + transcript tail. Transcript
  auto-attaches from the client's most recent call within 7 days — no picker.
  ONE GLM-5.3-Flash call (`PLAN_REASONING_EFFORT`, default 'low' — the
  compile is deterministic and rep-gated, speed wins), max 3 self-correction
  rounds. Failure of a template id match falls back to the generic baseline
  (a draft is never rejected).
- **Persistence.** Draft rides `spec_drafts` (source='plan', the validated
  plan in the new `plan` jsonb column, migration 20261002000001); the
  workflow row's name/description sync from the compiled spec so the rail
  reads well before publish. Response `{plan, draft, applied}`.
- **Builder chat is now spec-aware.** `admin-chat` injects CURRENT CONTEXT
  (workflow name + stored spec, placeholder specs contribute nothing) into
  the system prompt — "add a field" edits reality instead of regenerating
  from prose memory.
- **UI.** "Plan it for me" is the recommended first card in RecipePicker →
  brief step → the parent creates the workflow, plans into it, appends the
  plan card to the builder transcript (markdown, compiled draft attached —
  the existing "Load into preview" flow is the Test action), and pre-fills
  the composer with the open questions for Refine-in-chat.
- **E2E.** `supabase/tests/plan-e2e.sh` (prefix `__plan_e2e_*`): curated
  self-seed, save-as-template + v2 lineage, cross-client instantiate with
  slot application + provenance + identity safety, GLM plan → valid compiled
  draft, gateway isolation. Cleanup order matters (FKs): null
  `workflows.source_template_id` → null/drop templates → cascade clients.
  NOTE: `workflow_templates.created_from_workflow_id` references workflows
  WITHOUT cascade — deleting a client fails while a template points at its
  workflow; cleanup must null it first.

## Brand

Connective Labs: single accent `#FF6B35`, ink `#091426`, Tailwind **slate**
neutrals (never gray), system font stack only (no webfonts). Singapore English
copy: customise, organisation, colour, `S$3,000`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
