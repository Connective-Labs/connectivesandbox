# Modules catalogue — the builder's approved menu

The admin builder chat (`admin-chat`, model GLM-5.3-Flash) can only compose
workflows from the modules below. Its system prompt lives in the
`agent_instructions` table (`key = 'workflow_builder'`) and is read at request
time; the reproducible record is
`supabase/migrations/20260927000000_builder_prompt_modules_catalogue.sql`.
Every emitted spec is validated against the frozen Zod schema
(`src/engine/schema.ts`) before it reaches the browser, and the fixed
registry (`src/engine/registry.ts`) is the only renderer.

**New modules go through GitHub, not the chat.** The builder can never invent
a component; anything outside this catalogue must be added to
`src/engine/types.ts` + `src/engine/schema.ts` + `src/engine/registry.ts` via
a reviewed PR after the captain approves it. Judges never return free text —
closed answer sets only.

## Module design principles

Codified from the transcript-mining report
(`firstmate data store, connectivesandbox-transcript-mining/report.md`) —
every rule below is backed by real customer-call evidence, not imagination.

### What a module is

A module is a pre-built, pre-branded component with a fixed data contract,
mounted by name from the JSON spec.
There are two families: Collectors (intake) and Presenters (dashboard).
The spec supplies the data — labels, options, thresholds — and the module owns
rendering and data binding.

### The five tests

Every proposed module must pass all five, not some.

1. **A recurring shape of information.**
The same structure appears across customers, or it is flagship-critical.
"Show some text" is not a shape.
2. **The pipeline can fill it deterministically.**
You can name the data source: a judge answer, a decisions-ledger row, intake
state.
An unnameable data source means it is decoration — reject.
3. **A sales rep can request it in one sentence.**
The builder picks it from the catalogue without a paragraph of configuration.
4. **Its settings fit in a handful of typed fields.**
Fixed in the frozen type contract.
Open-ended configuration means it is custom code, not a module.
5. **Evidence from real calls.**
Multiple customers demanding it, or flagship-critical.

### The six constraints

1. **New modules are code, never chat.**
A GitHub PR adds the frozen type entry, the schema update, the component (with
empty, loading, and populated states), and a test.
The builder can CALL any module but can never CREATE one.
2. **Modules can only display what the pipeline produces.**
External data — WhatsApp, Shopify sync, PDF generation — is a backend phase;
in demos those modules represent sample data.
3. **No per-client logic.**
Client-specificity lives in spec data (options, thresholds, labels), never in
module behaviour.
4. **Flat composition.**
Modules stack as dashboard panels or inline chat cards; no arbitrary nesting,
no new page layouts.
Rich needs are several modules, not one mega-module.
5. **Contracts are migration costs.**
Design props data-driven from day one — a metrics list, not three hard-coded
numbers.
6. **The judge budget.**
Whatever fills a module arrives as closed, structured answers within the
per-question token budget; modules stay lean.

### The operational loop

A PR adds the type, the schema entry, the component, and the test.
Then update this catalogue AND the builder prompt's module menu (migration on
`agent_instructions`).
From then on the builder and openjev can call it, and reps can ask for it by
name.

## Intake components

| Component | Purpose | Behaviour notes |
| --- | --- | --- |
| `file_upload` | Collect files (images, PDFs) | `accept` MIME list (≥1), `multiple`, `instructions` shown to the user. Files land in the attachment tray. |
| `chat` | Conversational free-form intake | `placeholder` + `opening_message`. Mounted directly by `IntakeSurface`; carries the other intake components as inline cards. |
| `button_group` | One-tap closed choice | `options` (value/label, ≥1), `multi` for multi-select. Inline card submissions are chat sends. |
| `text_field` | Short or multiline typed input | `multiline: true` turns it into a textarea. |
| `form` | Structured multi-field record | Fields: `text` \| `textarea` \| `select` (select requires `options`); `required` optional per field. |
| `photo_slot` | Keyed per-item photo capture (module wave 1) | `label`, `capture_hint` (e.g. "include the rail in frame"), `accept` MIME list, `key` — the judge-state key picked files land under. Camera-capable picker; thumbnail grid after pick. |
| `follow_up_card` | Pre-authored clarification picker (module wave 1) | ONE question + choice chips (`options`, ≥1) + optional short text (`allow_text`) + send. Submission is a chat send; collapses to a sent chip. |

## Dashboard panels

| Panel | Purpose | Behaviour notes |
| --- | --- | --- |
| `confidence_meter` | Show one judge's confidence score | **The** surface that makes uncertainty visible; `judge_id` must reference an existing judge. |
| `analysis` | Narrative summary | `source: 'llm'` for the model's write-up, `'judges'` for a judge-derived digest. |
| `monitoring` | Ops metric tiles | `metrics` list; unknown metric names fall back to the decision count. |
| `decision_log` | Audit trail of decisions | `limit` (positive int). Include in **every** workflow so the human ownership trail is on screen. |
| `usage_counter` | Count of workflow runs | `label` only. |
| `triage_verdict` | Closed-set verdict card (module wave 1) | Large verdict chip + one-line reason (the judge's question + confidence) + the chosen follow-up. Reads `judge_id` (and optional `follow_up_judge_id`) from the decisions ledger; `verdicts` maps answer values to labels. |
| `quote_panel` | Quote / price card (module wave 1) | Headline price band (from `band_judge_id` decision through the `bands` map), itemised `lines`, `basis` footnote (job characteristics, never hours), `status` chip (draft/sent/accepted/expired). |
| `escalation_card` | Human handoff with context (module wave 1) | Named `contact` + `reason` + optional `reference` + one action button. Optional `judge_id` shows the linked decision; below-review confidence is highlighted. |
| `thread_preview` | Joined conversation view (module wave 1) | Read-only chat-style mini transcript: photo chip (from `photo_slot_key` intake state) → clarifying question → answer → quote (from `follow_up_judge_id` / `quote_judge_id` ledger rows). Only sources that produced something render. |
| `status_queue` | Ticket / order queue with actions (module wave 2) | Sortable (severity) and filterable rows with severity colour, state chips, and EXACTLY two per-row action buttons from the spec (`actions` — the "one yes, one not yet" shape). Rows are spec data in demos. |
| `alert_feed` | Ranked AI alerts (module wave 2) | Stacked alert cards: severity colour bar, source record, age, one deep-link button. `critical_after_days` escalates aged alerts; ranking is severity then age. |
| `kpi_tiles` | Headline metric tiles (module wave 2) | 2–4 tiles (pinned in schema): tabular numerals, optional spec-supplied delta arrows. Values derive from the decisions ledger; unknown `metric` names fall back to the decision count (same rule as `monitoring`). |
| `pipeline_tracker` | Stage tracker (module wave 2) | Horizontal stage chips (done/current/pending) with count badges per stage; `stages` (with optional counts) from spec. The current stage resolves from the `current_judge_id` decision, falling back to `current`. |

## Judge patterns + thresholds

Three patterns, all closed answer sets (a judge NEVER returns free text):

- **`choice`** — a fixed option list supplied in full (`options` required).
  Include an explicit `uncertain` / `cannot assess` option whenever the input
  may be ambiguous (blurry photo, unreadable scan).
- **`boolean`** — yes/no.
- **`scalar`** — a 0–1 score.

Each judge reads an array of intake component ids (`state_from`) and carries
`thresholds: { auto, review }` on a 0–1 scale, `auto ≥ review`.

**Defaults: `auto: 0.9`, `review: 0.5`.** Deviate only with a one-line reason —
the standard exception is a legibility/quality gate at `auto: 0.85`, since
marginal photos and scans are common.

## Escalation recipe (required for demo workflows)

Every demo workflow makes three things visible:

1. a judge whose below-review score or worst option maps to a **human
   handoff** — never to a guess;
2. a **confidence_meter** on that judge, so low confidence is shown;
3. a **decision_log** panel, so the ownership trail is on screen.

When the input is unclear the workflow must visibly say so and escalate —
this is the differentiator against the failed competitor product.

## Named recipes

- **Photo triage** (cleaning, repairs, damage assessment): intake is a `chat`
  (mounted directly) plus `photo_slot` per item with capture hints (rail in
  frame, doorway shot, fabric tag) and a `follow_up_card` carrying the
  pre-authored asks → legibility judge (`{quotable, one_ask, site_visit}`) →
  item archetype judge → one follow-up judge (which pre-authored ask unblocks
  the job) → price-band judge (`{band_a, band_b, band_c, needs_visit}`) →
  dashboard: `triage_verdict`, `quote_panel` (non-hourly basis footnote),
  `thread_preview`, `escalation_card`, `confidence_meter` on the judges,
  `decision_log`, `usage_counter`. *Flagship: Clean Shades photo-to-quote
  triage.*
- **Operations desk** (IT ticket triage, retail omnichannel): intake is a
  `chat` ("describe the problem like you'd WhatsApp it") plus a `form`
  (affected person, office, device — or channels/store) → severity judge →
  category judge → route judge (`{self_serve, automated, human_escalate}`) →
  dashboard: `status_queue` with exactly two per-row actions (Fulfil / Not
  yet), `alert_feed` (oversell risk, expiring quotations, price
  discrepancies), `kpi_tiles` (orders overnight, aged stock, online vs
  physical), `pipeline_tracker` (order → packed → dispatched, or quotation →
  PO → DO → invoice → payment), `escalation_card` for human-escalate routes,
  `decision_log`, `usage_counter`.
- **Document intake review** (claims, compliance packs): `file_upload` +
  `form` → completeness judge → quality/legibility judge → confidence_meter
  on each, `analysis` (`judges`), `decision_log`, `usage_counter`.
- **Approval desk** (applications, referrals, onboarding): `form` or
  `button_group` intake → eligibility judge → risk/fit judge →
  confidence_meter on each, `decision_log`, `usage_counter`.

## Refusal script

When asked for a capability no registered module supports (live map, outbound
WhatsApp/SMS, payment capture, calendar booking, …), the builder names the
missing module in one sentence — "There is no map component in the registry" —
and offers the closest registered alternative (e.g. capture the address as a
`text_field`). It never emits a spec containing unregistered components and
never approximates the feature with a judge or panel.

## Transcript-ready (built — livebuild v2)

Live transcription shipped: recording a discovery call classifies the rolling
transcript into KEYED FACTS (`live-facts`) and pure compilers
(`src/engine/compilers.ts`) turn the replayed ledger into spec drafts while
the conversation is still ongoing. The `admin-chat` contract REMAINS
machine-callable — a stateless message list in, a streamed reply out — so the
chat builder can still be driven headlessly in future. Recipes and this
modules catalogue are the constraint layer for BOTH build paths: the model can
only compose registered modules, and every spec still validates against the
frozen Zod schema before it reaches a browser.

## Validation record

Probed against the deployed function before and after hardening (2026-09-27).
After hardening: all five matrix scenarios produce the correct behaviour and
every emitted spec validates and publishes cleanly. Full transcript matrix:
firstmate data store, `connectivesandbox-builder-validate/report.md`.
