// Deterministic compilers — the spec is a COMPILED PROJECTION of the fact
// ledger, never an LLM artifact. For each named recipe (docs/modules.md) and
// for recipe-less sessions, a pure function turns the replayed ledger state
// into the exact WorkflowSpec JSON:
//
//   - one element per fact key, deduped by key BY CONSTRUCTION (Maps keyed by
//     element id) — regenerating any number of times cannot duplicate a panel
//     or slot;
//   - closed option sets and thresholds come from the catalogue only;
//   - human-language strings come from the fact's cached strings (GLM filled
//     them once, when the element was created) with catalogue fallbacks —
//     existing elements are never re-written, so drafts are stable;
//   - compiling the same state twice yields byte-identical JSON.
//
// Wave parity: `intake.photo` compiles the keyed photo_slot, `intake.files`
// the generic upload, `intake.follow_up` the clarification card; the
// photo-triage judge chain (archetype / follow-up / price band) and every
// wave dashboard panel (verdict, quote, thread, escalation, queue, alerts,
// KPI, pipeline) compile from their own catalogue keys, bound to the judges
// the ledger actually has.
//
// The frozen Zod schema (src/engine/schema.ts) remains the hard gate on every
// compiled draft — validated server-side before a draft version is written.
// Pure module: no imports from src/data/, Supabase, or any network library.

import type { DashboardPanel, IntakeComponent, Judge, WorkflowSpec } from './types.ts'
import type { LedgerFact } from './facts.ts'
import {
  applyFact,
  applyFacts,
  type FactLedgerState,
  type FactStateEntry,
} from './facts.ts'
import {
  ARCHETYPE_OPTIONS,
  DECISION_SETS,
  DEFAULT_STRINGS,
  FOLLOW_UP_OPTIONS,
  humaniseBand,
  humaniseOption,
  recipeSeedFacts,
  RECIPES,
  THRESHOLDS_QUALITY,
  THRESHOLDS_STANDARD,
  type RecipeId,
  WORKFLOW_TITLES,
  normaliseRecipeId,
} from './catalogue.ts'

/** Fixed intake order — deterministic inline-card flow in the chat surface. */
const INTAKE_ORDER = [
  'intake.photo',
  'intake.files',
  'intake.form',
  'intake.follow_up',
  'intake.request_kind',
  'intake.notes',
  'intake.chat',
] as const

/** Component id per intake key (stable, id-keyed string slots downstream). */
const INTAKE_COMPONENT_IDS: Record<string, string> = {
  'intake.photo': 'photo_slot',
  'intake.files': 'documents',
  'intake.chat': 'intake_chat',
  'intake.form': 'intake_form',
  'intake.follow_up': 'follow_up',
  'intake.request_kind': 'request_kind',
  'intake.notes': 'short_note',
}

/** Closed option set for the request-kind button group (catalogue value). */
const REQUEST_KIND_OPTIONS = [
  { value: 'new_request', label: 'New request' },
  { value: 'follow_up', label: 'Follow-up' },
]

/** Closed option chips for the follow-up card (catalogue value). */
const FOLLOW_UP_CARD_OPTIONS = [
  { value: 'photos_needed', label: 'I can send more photos' },
  { value: 'visit_needed', label: 'Book a site visit' },
]

const PHOTO_ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
/** Judge-state key picked photo_slot files land under (thread_preview binds it). */
const PHOTO_SLOT_KEY = 'photos'

/** Dashboard confidence-meter labels per judge id (fixed, not GLM-authored). */
const JUDGE_METER_LABELS: Record<string, string> = {
  decision_judge: 'Decision confidence',
  escalation_judge: 'Escalation signal',
  quality_score: 'Submission quality',
  archetype_judge: 'Item type confidence',
  follow_up_judge: 'Follow-up confidence',
  price_band_judge: 'Price band confidence',
}

function getString(entry: FactStateEntry | undefined, slot: string): string | null {
  const value = entry?.detail.strings?.[slot as keyof typeof entry.detail.strings]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function defaultString(key: string, slot: string): string {
  return DEFAULT_STRINGS[key]?.[slot] ?? ''
}

/** Cached string or catalogue default — the ONLY two sources of copy. */
function slotString(entry: FactStateEntry | undefined, key: string, slot: string): string {
  return getString(entry, slot) ?? defaultString(key, slot)
}

/** Active intake components, in the fixed catalogue order. */
function compileIntake(state: FactLedgerState): IntakeComponent[] {
  const components: IntakeComponent[] = []
  const seen = new Set<string>()
  for (const key of INTAKE_ORDER) {
    const entry = state.get(key)
    if (entry === undefined || !entry.active) continue
    const id = INTAKE_COMPONENT_IDS[key]
    if (id === undefined || seen.has(id)) continue // duplicate-proof by key
    seen.add(id)
    switch (key) {
      case 'intake.photo':
        components.push({
          type: 'photo_slot',
          id,
          label: slotString(entry, key, 'label'),
          capture_hint: slotString(entry, key, 'capture_hint'),
          accept: [...PHOTO_ACCEPT],
          key: PHOTO_SLOT_KEY,
        })
        break
      case 'intake.files':
        components.push({
          type: 'file_upload',
          id,
          label: slotString(entry, key, 'label'),
          accept: [...PHOTO_ACCEPT],
          multiple: true,
          instructions: slotString(entry, key, 'instructions'),
        })
        break
      case 'intake.chat':
        components.push({
          type: 'chat',
          id,
          placeholder: slotString(entry, key, 'placeholder'),
          opening_message: slotString(entry, key, 'opening_message'),
        })
        break
      case 'intake.form':
        components.push({
          type: 'form',
          id,
          fields: [
            {
              id: 'detail_note',
              type: 'textarea',
              required: false,
              label: slotString(entry, key, 'question'),
            },
          ],
        })
        break
      case 'intake.follow_up':
        components.push({
          type: 'follow_up_card',
          id,
          label: slotString(entry, key, 'label'),
          question: slotString(entry, key, 'question'),
          options: FOLLOW_UP_CARD_OPTIONS.map((option) => ({ ...option })),
          allow_text: true,
        })
        break
      case 'intake.request_kind':
        components.push({
          type: 'button_group',
          id,
          label: slotString(entry, key, 'label'),
          options: REQUEST_KIND_OPTIONS.map((option) => ({ ...option })),
          multi: false,
        })
        break
      case 'intake.notes':
        components.push({
          type: 'text_field',
          id,
          label: slotString(entry, key, 'label'),
          multiline: false,
        })
        break
    }
  }
  // An intake surface must exist; the chat component is the universal intake.
  if (components.length === 0) {
    components.push({
      type: 'chat',
      id: 'intake_chat',
      placeholder: defaultString('intake.chat', 'placeholder'),
      opening_message: defaultString('intake.chat', 'opening_message'),
    })
  }
  return components
}

/** Decision-judge options: the chosen catalogue set narrowed by option facts.
 *  Fewer than two surviving options falls back to the full closed set — a
 *  choice judge always has a legal, non-trivial option list. */
function decisionOptions(state: FactLedgerState, decisionSetKey: string): string[] {
  const set = DECISION_SETS[decisionSetKey] ?? DECISION_SETS.quote_or_visit
  const surviving = set.options.filter((option) => {
    const entry = state.get(`judge.decision.options.${option}`)
    return entry === undefined || entry.active
  })
  return (surviving.length >= 2 ? surviving : set.options).slice()
}

function compileJudges(state: FactLedgerState, recipeId: RecipeId, stateFrom: string[]): Judge[] {
  const judges: Judge[] = []

  const decisionEntry = state.get('judge.decision')
  if (decisionEntry !== undefined && decisionEntry.active) {
    const requested = decisionEntry.detail.meta?.decision_set
    const decisionSetKey =
      typeof requested === 'string' && requested in DECISION_SETS
        ? requested
        : (RECIPES[recipeId].seeds.find((seedItem) => seedItem.key === 'judge.decision')?.detail.meta?.decision_set as string | undefined) ??
          'quote_or_visit'
    judges.push({
      id: 'decision_judge',
      state_from: stateFrom,
      question: slotString(decisionEntry, 'judge.decision', 'question'),
      question_type: 'choice',
      options: decisionOptions(state, decisionSetKey),
      thresholds: { ...THRESHOLDS_STANDARD },
    })
  }

  const escalationEntry = state.get('judge.escalation')
  if (escalationEntry !== undefined && escalationEntry.active) {
    judges.push({
      id: 'escalation_judge',
      state_from: stateFrom,
      question: slotString(escalationEntry, 'judge.escalation', 'question'),
      question_type: 'boolean',
      thresholds: { ...THRESHOLDS_STANDARD },
    })
  }

  const qualityEntry = state.get('judge.quality')
  if (qualityEntry !== undefined && qualityEntry.active) {
    judges.push({
      id: 'quality_score',
      state_from: stateFrom,
      question: slotString(qualityEntry, 'judge.quality', 'question'),
      question_type: 'scalar',
      thresholds: { ...THRESHOLDS_QUALITY },
    })
  }

  const archetypeEntry = state.get('judge.archetype')
  if (archetypeEntry !== undefined && archetypeEntry.active) {
    judges.push({
      id: 'archetype_judge',
      state_from: stateFrom,
      question: slotString(archetypeEntry, 'judge.archetype', 'question'),
      question_type: 'choice',
      options: [...ARCHETYPE_OPTIONS],
      thresholds: { ...THRESHOLDS_STANDARD },
    })
  }

  const followUpEntry = state.get('judge.follow_up')
  if (followUpEntry !== undefined && followUpEntry.active) {
    judges.push({
      id: 'follow_up_judge',
      state_from: stateFrom,
      question: slotString(followUpEntry, 'judge.follow_up', 'question'),
      question_type: 'choice',
      options: [...FOLLOW_UP_OPTIONS],
      thresholds: { ...THRESHOLDS_STANDARD },
    })
  }

  const priceBandEntry = state.get('judge.price_band')
  if (priceBandEntry !== undefined && priceBandEntry.active) {
    judges.push({
      id: 'price_band_judge',
      state_from: stateFrom,
      question: slotString(priceBandEntry, 'judge.price_band', 'question'),
      question_type: 'choice',
      options: [...DECISION_SETS.price_band.options],
      thresholds: { ...THRESHOLDS_STANDARD },
    })
  }

  return judges
}

function compileDashboard(state: FactLedgerState, judges: Judge[]): DashboardPanel[] {
  const panels: DashboardPanel[] = []
  const seen = new Set<string>()
  const push = (panel: DashboardPanel) => {
    if (seen.has(panel.id)) return
    seen.add(panel.id)
    panels.push(panel)
  }
  const hasJudge = (id: string) => judges.some((judge) => judge.id === id)
  const active = (key: string) => {
    const entry = state.get(key)
    return entry !== undefined && entry.active ? entry : undefined
  }

  // One confidence meter per judge, in judge order.
  for (const judge of judges) {
    push({
      type: 'confidence_meter',
      id: `confidence_${judge.id}`,
      judge_id: judge.id,
      label: JUDGE_METER_LABELS[judge.id] ?? 'Decision confidence',
    })
  }

  // Wave 1 — the photo-triage story. Judge-bound panels compile only when
  // the judge they read actually exists (modules.md: judge_id must reference
  // an existing judge).
  const verdictEntry = active('dashboard.triage_verdict')
  const decisionJudge = judges.find((judge) => judge.id === 'decision_judge')
  if (verdictEntry !== undefined && decisionJudge !== undefined) {
    push({
      type: 'triage_verdict',
      id: 'triage_verdict',
      judge_id: 'decision_judge',
      verdicts: (decisionJudge.options ?? []).map((option) => ({ value: option, label: humaniseOption(option) })),
      ...(hasJudge('follow_up_judge') ? { follow_up_judge_id: 'follow_up_judge' } : {}),
    })
  }

  const quoteEntry = active('dashboard.quote')
  if (quoteEntry !== undefined && hasJudge('price_band_judge')) {
    push({
      type: 'quote_panel',
      id: 'quote',
      title: slotString(quoteEntry, 'dashboard.quote', 'title'),
      lines: [{ label: 'To be confirmed after review', amount: 'TBC' }],
      basis: slotString(quoteEntry, 'dashboard.quote', 'basis'),
      status: 'draft',
      band_judge_id: 'price_band_judge',
      bands: DECISION_SETS.price_band.options.map((option) => ({ value: option, label: humaniseBand(option) })),
    })
  }

  const threadEntry = active('dashboard.thread')
  if (threadEntry !== undefined) {
    push({
      type: 'thread_preview',
      id: 'thread',
      title: slotString(threadEntry, 'dashboard.thread', 'title'),
      ...(state.get('intake.photo')?.active === true ? { photo_slot_key: PHOTO_SLOT_KEY } : {}),
      ...(hasJudge('follow_up_judge') ? { follow_up_judge_id: 'follow_up_judge' } : {}),
      ...(hasJudge('price_band_judge') ? { quote_judge_id: 'price_band_judge' } : {}),
    })
  }

  const escalationEntry = active('dashboard.escalation')
  if (escalationEntry !== undefined) {
    push({
      type: 'escalation_card',
      id: 'escalation',
      contact: slotString(escalationEntry, 'dashboard.escalation', 'contact'),
      reason: slotString(escalationEntry, 'dashboard.escalation', 'reason'),
      action_label: slotString(escalationEntry, 'dashboard.escalation', 'action_label'),
      ...(hasJudge('escalation_judge') ? { judge_id: 'escalation_judge' } : {}),
    })
  }

  // Wave 2 — the operations-desk story.
  const queueEntry = active('dashboard.queue')
  if (queueEntry !== undefined) {
    push({
      type: 'status_queue',
      id: 'work_queue',
      title: slotString(queueEntry, 'dashboard.queue', 'title'),
      rows: [
        { id: 'demo', label: 'Sample item — live rows appear once the queue is connected', source: 'manual', severity: 'low', state: 'new' },
      ],
      actions: [
        { value: 'fulfil', label: 'Fulfil', primary: true },
        { value: 'not_yet', label: 'Not yet', primary: false },
      ],
    })
  }

  const alertsEntry = active('dashboard.alerts')
  if (alertsEntry !== undefined) {
    push({
      type: 'alert_feed',
      id: 'alerts',
      title: slotString(alertsEntry, 'dashboard.alerts', 'title'),
      alerts: [
        { id: 'demo', title: 'Sample alert — aged items escalate automatically', source: 'system', age_days: 0, severity: 'low' },
      ],
      action_label: slotString(alertsEntry, 'dashboard.alerts', 'action_label'),
      critical_after_days: 30,
    })
  }

  const kpiEntry = active('dashboard.kpi')
  if (kpiEntry !== undefined) {
    push({
      type: 'kpi_tiles',
      id: 'kpi_headline',
      title: slotString(kpiEntry, 'dashboard.kpi', 'title'),
      metrics: [
        { label: 'Decisions', metric: 'decisions' },
        { label: 'Runs', metric: 'runs' },
      ],
    })
  }

  const pipelineEntry = active('dashboard.pipeline')
  if (pipelineEntry !== undefined) {
    push({
      type: 'pipeline_tracker',
      id: 'pipeline',
      title: slotString(pipelineEntry, 'dashboard.pipeline', 'title'),
      stages: [{ label: 'Received' }, { label: 'In review' }, { label: 'Done' }],
      ...(decisionJudge !== undefined ? { current_judge_id: 'decision_judge' } : {}),
    })
  }

  const summaryEntry = state.get('dashboard.summary')
  if (summaryEntry !== undefined && summaryEntry.active) {
    push({ type: 'analysis', id: 'summary', title: slotString(summaryEntry, 'dashboard.summary', 'title'), source: 'llm' })
  }
  const metricsEntry = state.get('dashboard.metrics')
  if (metricsEntry !== undefined && metricsEntry.active) {
    push({ type: 'monitoring', id: 'ops_metrics', metrics: ['decisions', 'runs'] })
  }
  // The human ownership trail and the run counter are in EVERY workflow.
  push({ type: 'decision_log', id: 'ownership_log', limit: 20 })
  push({ type: 'usage_counter', id: 'runs', label: 'Workflow runs' })
  return panels
}

function titleFor(recipeId: RecipeId): { name: string; description: string } {
  if (recipeId === 'generic') return { ...WORKFLOW_TITLES.generic }
  const recipe = RECIPES[recipeId]
  return { name: recipe.name, description: recipe.description }
}

/**
 * Compile a WorkflowSpec from a fact ledger state. Deterministic: the same
 * (recipeId, state) always compiles to the identical spec. Named recipe seed
 * facts fill ONLY the keys the session ledger has never seen — a seed can
 * never resurrect a key the customer explicitly removed, and the session's
 * facts always win over the baseline.
 */
export function compileRecipe(recipeId: RecipeId, state: FactLedgerState): WorkflowSpec {
  let full = state
  if (recipeId !== 'generic') {
    for (const seedFact of recipeSeedFacts(recipeId)) {
      if (!full.has(seedFact.key)) full = applyFact(full, seedFact)
    }
  }
  const intake = compileIntake(full)
  const judges = compileJudges(full, recipeId, intake.map((component) => component.id))
  const title = titleFor(recipeId)
  return {
    name: title.name,
    description: title.description,
    intake: { components: intake },
    judges,
    dashboard: { panels: compileDashboard(full, judges) },
  }
}

/**
 * Compile for a session: recipeId normalised (unknown → generic).
 */
export function compileSpec(recipeId: string | null | undefined, state: FactLedgerState): WorkflowSpec {
  return compileRecipe(normaliseRecipeId(recipeId), state)
}

/** Compile with a raw fact list (replay → compile). Handy for tests/tools. */
export function compileFacts(recipeId: string | null | undefined, facts: LedgerFact[]): WorkflowSpec {
  return compileSpec(recipeId, applyFacts(facts))
}
