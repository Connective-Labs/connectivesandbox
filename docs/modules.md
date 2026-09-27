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

## Intake components

| Component | Purpose | Behaviour notes |
| --- | --- | --- |
| `file_upload` | Collect files (images, PDFs) | `accept` MIME list (≥1), `multiple`, `instructions` shown to the user. Files land in the attachment tray. |
| `chat` | Conversational free-form intake | `placeholder` + `opening_message`. Mounted directly by `IntakeSurface`; carries the other intake components as inline cards. |
| `button_group` | One-tap closed choice | `options` (value/label, ≥1), `multi` for multi-select. Inline card submissions are chat sends. |
| `text_field` | Short or multiline typed input | `multiline: true` turns it into a textarea. |
| `form` | Structured multi-field record | Fields: `text` \| `textarea` \| `select` (select requires `options`); `required` optional per field. |

## Dashboard panels

| Panel | Purpose | Behaviour notes |
| --- | --- | --- |
| `confidence_meter` | Show one judge's confidence score | **The** surface that makes uncertainty visible; `judge_id` must reference an existing judge. |
| `analysis` | Narrative summary | `source: 'llm'` for the model's write-up, `'judges'` for a judge-derived digest. |
| `monitoring` | Ops metric tiles | `metrics` list; unknown metric names fall back to the decision count. |
| `decision_log` | Audit trail of decisions | `limit` (positive int). Include in **every** workflow so the human ownership trail is on screen. |
| `usage_counter` | Count of workflow runs | `label` only. |

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

- **Photo triage** (cleaning, repairs, damage assessment): `file_upload`
  (+ `text_field` or `chat` for context) → legibility/photo-quality judge →
  item archetype judge → one follow-up judge (the single question customers
  answer reliably) → confidence_meter on each of the three judges,
  `analysis`, `decision_log`, `usage_counter`. *Flagship: Clean Shades
  photo-to-quote triage.*
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

## Validation record

Probed against the deployed function before and after hardening (2026-09-27).
After hardening: all five matrix scenarios produce the correct behaviour and
every emitted spec validates and publishes cleanly. Full transcript matrix:
firstmate data store, `connectivesandbox-builder-validate/report.md`.
