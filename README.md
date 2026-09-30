# Connective Sandbox

Connective Sandbox is a multi-tenant AI workflow console: an administrator
chat-builds a workflow with a GLM agent (the agent emits a validated JSON
spec, never UI), publishes it, and clients then log in with a four-digit
access code, submit an intake (files, photos, chat), and receive instant
structured decisions from specialised judge models — every decision,
confidence, and latency lands in a `decisions` ledger that powers the
dashboards. Build brief: Notion page "Connective Sandbox — GLM Build
Instructions" (id `292f699a-4023-469d-8ebd-54167f9e8c13` — the complete,
authoritative specification); `AGENTS.md` records the phase-gate decisions.

## Architecture invariants

These are enforced from Phase 1 onward; see `AGENTS.md` for the full list and
the reasoning behind each decision.

1. **No model emits UI at runtime.** The admin LLM emits a JSON `WorkflowSpec`
   validated against the Zod schema in `src/engine/schema.ts`; the fixed
   component registry (`src/engine/registry.ts`) renders it.
2. **`src/engine/` is pure.** It imports nothing from `src/data/`, Supabase,
   or any network library — types, schema, registry, runner only. The runner
   receives a `JudgeProvider` by injection.
3. **`src/engine/types.ts` is frozen.** Never edit it.
4. **All data access goes through `src/data/adapters/`.** Components never
   call Supabase or an Edge Function directly. Adapters hit the real backend
   (relative same-origin `/functions/v1/...` calls).
5. **A judge never returns free text.** `JudgeAnswer.value` is
   `string | boolean | number`; choice judges carry a full `probabilities`
   distribution. Any unparseable answer throws `JudgeParseError`, which
   `run-workflow` records as confidence-0 ledger rows — there is no code path
   that substitutes an LLM judgement for a judge.
6. **The decision ledger is the single source of truth.** `run-workflow`
   writes one `decisions` row per judge (always, with `latency_ms`); every
   dashboard number, usage total, and monitoring tile traces to those rows.
   The admin live preview is the only sanctioned exception: it runs locally
   on the mock provider and never consumes judge calls or writes rows.
7. **Secrets only live in Edge Functions.** No model key, judge credential,
   or `service_role` key ever reaches the browser. The browser bundle carries
   only the Supabase project URL and anon key (public by design).

## Local development

```bash
cp .env.example .env.local   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm ci
npm run dev                  # Vite on localhost, proxying /functions to Supabase
npm run build                # type-check (strict) + production build
npm run lint
```

The session cookie is `SameSite=Strict`, so the dev/preview server proxies
`/functions` to the Supabase project (see `vite.config.ts`); production uses
an equivalent same-origin rewrite.

## Deploy (Supabase Edge Functions)

```bash
supabase functions serve          # local
supabase functions deploy auth-code auth-codes admin-api admin-chat client-chat \
  run-workflow artifact-api feedback live-draft live-facts live-transcribe plan-workflow
```

Configuration is by **secret NAME only** — never commit or paste values:

- `JWT_SECRET` — HS256 signing key for session JWTs.
- `ADMIN_ACCESS_CODE` — the admin's four-digit code.
- `ZAI_API_KEY` — the GLM builder/chat/planner credential (admin-chat,
  client-chat, run-workflow's analysis, the feedback planner).
- `JUDGE_PROVIDER` — `jev` (default) | `laya_modal` | `laya_space` | `mock`.
- `JUDGE_ENDPOINT_URL`, `JUDGE_API_KEY` (+ optional `JUDGE_MODEL`) — judge
  credentials, resolved only inside `run-workflow`, `feedback`, and
  `live-facts`.
- `DEEPGRAM_API_KEY` (+ optional `DEEPGRAM_MODEL`, `DEEPGRAM_LANGUAGE`) —
  when set, live build uses server transcription (all browsers); Web Speech
  is the fallback.
- `GLM_MODEL`, `GLM_REASONING_EFFORT` — builder/chat model overrides.
- `PLANNER_ADAPTER` — `'glm'` (default) | `'none'` disables feedback drafts.
- `FEEDBACK_PLANNER_MAX_PER_HOUR` — per-client planner spend bound (default 5).
- `PLAN_MAX_PER_HOUR`, `PLAN_REASONING_EFFORT` — GLM planning-stage guard
  (default 10/hour) and effort (default `low`).
- `SCREEN_COOLDOWN_SECONDS` / `EXTRACT_COOLDOWN_SECONDS` /
  `DRAFT_COOLDOWN_SECONDS` / `MAX_FACTS_PER_SESSION` — live-build cadences.
- `ALLOWED_ORIGINS` — CORS allow-list (never a wildcard with credentials).

## Judge setup

`JUDGE_PROVIDER` selects the provider (`src/services/judge/factory.ts`):

- **`jev`** — the live provider: Codiv openjev via `/v1/systemone`. This is
  what production runs; all judges in a workflow are batched into ONE
  request, with a 512-token-per-question state budget enforced by a
  deterministic compressor (`compress.ts`, truncation event logged).
- **`laya_modal` / `laya_space`** — implemented per the Laya contract,
  untested (no live endpoint provisioned).
- **`mock`** — deterministic canned answers for tests and the admin live
  preview; never free text, always a full probability distribution.

## Documented sandbox trade-off

Client access codes are stored **plaintext** in `clients.access_code` by
design, so the admin can read a code out to a client over WhatsApp. The
four-digit gate is **client-side** (captain decision, polish 3): the browser
validates the entered code against the code → {role, client_id} map served
publicly by the `auth-codes` Edge Function, then the `auth-code` function
mints the session JWT from that trusted-by-design browser decision — it does
NOT validate codes, count attempts, or rate-limit anything. This mapping is
PUBLIC BY DESIGN: the codes are a convenience gate for a sandbox that will
not see enough traffic to misuse them, not a security boundary. A production
hardening would replace them with client-specific one-time enrolment links
and server-side validation; the rest of the auth design (httpOnly Secure
SameSite=Strict cookie, server-side session resolution) does not need to
change.

## Project layout

- `src/engine/` — pure spec schema, component registry, judge runner.
- `src/services/judge/` — judge providers (jev / laya / mock), token budget
  compressor, factory. Shared by the Edge Functions via Deno import.
- `src/data/adapters/` — the only place that talks to the backend.
- `src/state/`, `src/components/`, `src/screens/` — React UI.
- `supabase/functions/` — Deno Edge Functions (`auth-code`, `admin-api`,
  `admin-chat`, `client-chat`, `run-workflow`, `artifact-api`).
- `supabase/migrations/` — schema + RLS.

Agent sessions: read `AGENTS.md` first and obey its invariants.
