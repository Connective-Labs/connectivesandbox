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

## Live transcription pipeline (Phase 8 — live build while the rep talks)

- **STT adapter decision.** v1 engine is the browser's Web Speech API
  (`webkitSpeechRecognition`, Chrome-only) behind a small `TranscriptionEngine`
  interface (`start/stop` + `onSegment` handlers) in
  `src/data/adapters/transcribe.ts` — no package, degraded gracefully with
  "Live transcription needs Chrome." A streaming server engine (Deepgram/
  Whisper) slots in later by implementing the same interface; the UI never
  talks to the browser API directly. Interim results feed live captions only;
  final text segments are the sole durable artefact. **No audio ever leaves
  the browser.**
- **jev/GLM hybrid (captain decision, supersedes full-GLM regeneration).** In
  `live-draft`, openjev drives STRUCTURE via ONE batched closed-choice call:
  materiality (the change trigger) plus per-class intake ops
  (add/keep/remove), the decision set (catalogue choices), and a scalar
  quality-judge flag. The spec skeleton is assembled deterministically from
  legal catalogue parts (`DECISION_SETS`, component ids, thresholds in the
  function); GLM-5.3-Flash fills STRING SLOTS ONLY (labels, hints, question
  wording) against an id-keyed slot whitelist — it can never add, remove,
  reorder, or re-key anything. Zod validation remains the hard gate with a
  deterministic-strings retry; by construction it nearly always passes.
- **Durability + RLS choice.** `transcript_segments` and `spec_drafts`
  (migrations 20260928000000/1) follow the Phase 5 gateway pattern: RLS
  enabled, NO policies (default deny) — like `clients`/`agent_instructions`,
  they are reachable ONLY via service_role inside Edge Functions, so even a
  valid client JWT sees zero rows (isolation test extended + passing).
  Publishing a draft rides the existing publish path (PUT spec, version bump);
  the draft row is then flagged via live-draft PATCH.
- **Rate guard / draft floor.** At most one draft per
  `DRAFT_COOLDOWN_SECONDS` (default 15) per (client_id, session_id), enforced
  in `live-draft` from `spec_drafts` so it survives isolate recycling; the
  client additionally debounces 4s after the last final segment. A suppressed
  draft returns `draft_suppressed: true` instead of spending GLM tokens.
- **UI.** Centre column of the admin screen is tabbed: Builder (chat,
  primary path — typing/recipes stay the default) and Live build
  (`src/components/admin/LiveBuild.tsx`, secondary channel): record control
  with pulsing dot + elapsed, monospace rolling captions, numbered draft rail
  (newest auto-loads into the existing preview; click to reload; one-click
  discard with confirm). Publish stays the right-column action on the
  previewed spec — the rep is the UAT gate.
- **Verification.** `supabase/tests/live-transcribe-e2e.sh` drives the whole
  pipeline headless (synthetic discovery call → screened beats → versioned
  drafts → rate guard → publish → client sees the spec). Chrome CDN is
  blocked in the build sandbox, so browser-level verification was by bundle
  grep + build; a dev-browser pass on LiveBuild remains worthwhile for the
  captain.

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

## Brand

Connective Labs: single accent `#FF6B35`, ink `#091426`, Tailwind **slate**
neutrals (never gray), system font stack only (no webfonts). Singapore English
copy: customise, organisation, colour, `S$3,000`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
