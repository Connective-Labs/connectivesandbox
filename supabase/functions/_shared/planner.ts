// Planner adapter — the parallel-AI edit pipeline behind the feedback
// channel. The `feedback` Edge Function calls `resolvePlanner()` and applies
// the returned proposal DETERMINISTICALLY; a planner can never mutate a spec
// by itself.
//
// Adapter contract (documented in AGENTS.md):
//
//   interface SpecPlanner {
//     name: string
//     plan(input: { feedback, classification, currentSpec }): Promise<PlannerProposal>
//   }
//
//   interface PlannerProposal {
//     strings: Record<string, string>      // whitelisted string slots → new copy
//     componentOps: { op: 'add' | 'remove'; component: ComponentKind }[]
//     thresholdTweaks: { judgeId: string; auto?: number; review?: number }[]
//     summary: string                      // plain-language diff for the rep
//   }
//
// The v1 implementation is GLM-5.3-Flash (Z.ai endpoint, plain fetch). A
// Claude or other planner slots in later by adding a branch to
// `resolvePlanner()` — no caller or UI change. Selection is env-driven
// (PLANNER_ADAPTER: 'glm' default | 'none' disables drafting).
//
// Hybrid discipline (captain decision, same as live-draft): the planner
// picks STRUCTURE from the closed module catalogue and fills STRING SLOTS
// from a whitelist computed from the current spec; the applier below
// validates every key, clamps thresholds to the bounded band (±0.1 from the
// current value, review never below 0.5, auto never above 0.95, review
// strictly below auto), and the frozen Zod schema remains the hard gate in
// the caller.
//
// Module coverage: every intake component AND every dashboard panel from the
// wave 1+2 extension is rewordable. Addable/removable: the intake kinds plus
// the panels that build validly from generic catalogue data. Judge-bound
// panels (triage_verdict, quote_panel, thread_preview) are reword-only —
// their verdict maps and quote lines are too spec-specific to auto-add.
// decision_log and usage_counter are ALWAYS-ON (the ownership trail and run
// counter are in every workflow by design) — never added, never removed.

import type { DashboardPanel, IntakeComponent, Judge, WorkflowSpec } from '../../../src/engine/types.ts'
import { glmChat } from '../_shared/glm.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntakeKind =
  | 'file_upload'
  | 'chat'
  | 'form'
  | 'button_group'
  | 'text_field'
  | 'photo_slot'
  | 'follow_up_card'

export type PanelKind =
  | 'confidence_meter'
  | 'analysis'
  | 'monitoring'
  | 'escalation_card'
  | 'kpi_tiles'
  | 'pipeline_tracker'
  | 'status_queue'
  | 'alert_feed'

export type ComponentKind = IntakeKind | PanelKind

export interface PlannerProposal {
  strings: Record<string, string>
  componentOps: { op: 'add' | 'remove'; component: ComponentKind }[]
  thresholdTweaks: { judgeId: string; auto?: number; review?: number }[]
  summary: string
}

export interface FeedbackPlannerInput {
  feedback: string
  classification: 'wording' | 'structure'
  currentSpec: WorkflowSpec
}

export interface SpecPlanner {
  name: string
  plan(input: FeedbackPlannerInput): Promise<PlannerProposal>
}

// ---------------------------------------------------------------------------
// Deterministic catalogue — legal parts only (docs/modules.md). Component
// ids, option sets and default strings are catalogue values; a planner may
// only add/remove whole components or panels.
// ---------------------------------------------------------------------------

export const INTAKE_KINDS: readonly IntakeKind[] = [
  'file_upload',
  'chat',
  'form',
  'button_group',
  'text_field',
  'photo_slot',
  'follow_up_card',
]

export const PANEL_KINDS: readonly PanelKind[] = [
  'confidence_meter',
  'analysis',
  'monitoring',
  'escalation_card',
  'kpi_tiles',
  'pipeline_tracker',
  'status_queue',
  'alert_feed',
]

export const COMPONENT_KINDS: readonly ComponentKind[] = [...INTAKE_KINDS, ...PANEL_KINDS]

/** Panels present in every workflow by design — never planner-removable. */
const ALWAYS_ON_PANELS: ReadonlySet<string> = new Set(['decision_log', 'usage_counter'])

const PHOTO_ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

interface CatalogueIntake {
  area: 'intake'
  build: () => IntakeComponent
  slots: (id: string) => Record<string, string>
}

interface CataloguePanel {
  area: 'dashboard'
  /** null when the panel cannot be built validly for this spec (e.g. a
   *  confidence_meter with no judge to bind). */
  build: (judges: Judge[]) => DashboardPanel | null
  slots: (id: string) => Record<string, string>
}

export const CATALOGUE: Record<ComponentKind, CatalogueIntake | CataloguePanel> = {
  // --- Intake components ---------------------------------------------------
  file_upload: {
    area: 'intake',
    build: () => ({
      type: 'file_upload',
      id: 'photo_slot',
      label: 'Photos of the item',
      accept: [...PHOTO_ACCEPT],
      multiple: true,
      instructions: 'Upload clear photos of the affected area — sharp, well-lit, whole item in frame.',
    }),
    slots: (id) => ({
      [`intake.components.${id}.label`]: 'Photos of the item',
      [`intake.components.${id}.instructions`]:
        'Upload clear photos of the affected area — sharp, well-lit, whole item in frame.',
    }),
  },
  chat: {
    area: 'intake',
    build: () => ({
      type: 'chat',
      id: 'intake_chat',
      placeholder: 'Describe what you need…',
      opening_message: 'Tell us about the job and attach photos where helpful.',
    }),
    slots: (id) => ({
      [`intake.components.${id}.placeholder`]: 'Describe what you need…',
      [`intake.components.${id}.opening_message`]: 'Tell us about the job and attach photos where helpful.',
    }),
  },
  form: {
    area: 'intake',
    build: () => ({
      type: 'form',
      id: 'intake_form',
      fields: [{ id: 'detail_note', type: 'textarea', required: false, label: 'Describe the job in your own words' }],
    }),
    slots: (id) => ({
      [`intake.components.${id}.fields.detail_note.label`]: 'Describe the job in your own words',
    }),
  },
  button_group: {
    area: 'intake',
    build: () => ({
      type: 'button_group',
      id: 'request_kind',
      label: 'What kind of request is this?',
      options: [
        { value: 'new_request', label: 'New request' },
        { value: 'follow_up', label: 'Follow-up' },
      ],
      multi: false,
    }),
    slots: (id) => ({
      [`intake.components.${id}.label`]: 'What kind of request is this?',
      [`intake.components.${id}.options.new_request.label`]: 'New request',
      [`intake.components.${id}.options.follow_up.label`]: 'Follow-up',
    }),
  },
  text_field: {
    area: 'intake',
    build: () => ({
      type: 'text_field',
      id: 'short_note',
      label: 'Anything else we should know?',
      multiline: false,
    }),
    slots: (id) => ({ [`intake.components.${id}.label`]: 'Anything else we should know?' }),
  },
  photo_slot: {
    area: 'intake',
    build: () => ({
      type: 'photo_slot',
      id: 'item_photos',
      label: 'Photos of the item',
      capture_hint: 'Include the whole item in frame — sharp, well-lit, no clutter.',
      accept: [...PHOTO_ACCEPT],
      key: 'photos',
    }),
    slots: (id) => ({
      [`intake.components.${id}.label`]: 'Photos of the item',
      [`intake.components.${id}.capture_hint`]: 'Include the whole item in frame — sharp, well-lit, no clutter.',
    }),
  },
  follow_up_card: {
    area: 'intake',
    build: () => ({
      type: 'follow_up_card',
      id: 'follow_up',
      label: 'One quick question',
      question: 'Which of these would unblock the job?',
      options: [
        { value: 'more_photos', label: 'I can send more photos' },
        { value: 'book_visit', label: 'Book a site visit' },
      ],
      allow_text: true,
    }),
    slots: (id) => ({
      [`intake.components.${id}.label`]: 'One quick question',
      [`intake.components.${id}.question`]: 'Which of these would unblock the job?',
      [`intake.components.${id}.options.more_photos.label`]: 'I can send more photos',
      [`intake.components.${id}.options.book_visit.label`]: 'Book a site visit',
    }),
  },

  // --- Dashboard panels ----------------------------------------------------
  confidence_meter: {
    area: 'dashboard',
    build: (judges) => {
      const judge = judges[0]
      if (judge === undefined) return null
      return { type: 'confidence_meter', id: `confidence_${judge.id}`, judge_id: judge.id, label: 'Decision confidence' }
    },
    slots: (id) => ({ [`dashboard.panels.${id}.label`]: 'Decision confidence' }),
  },
  analysis: {
    area: 'dashboard',
    build: () => ({ type: 'analysis', id: 'summary', title: 'Summary', source: 'llm' }),
    slots: (id) => ({ [`dashboard.panels.${id}.title`]: 'Summary' }),
  },
  monitoring: {
    area: 'dashboard',
    build: () => ({ type: 'monitoring', id: 'ops_metrics', metrics: ['decisions', 'runs'] }),
    slots: () => ({}),
  },
  escalation_card: {
    area: 'dashboard',
    build: (judges) => ({
      type: 'escalation_card',
      id: 'escalation',
      contact: 'The duty manager',
      reason: 'Anything the AI cannot decide confidently is routed here for a human check.',
      action_label: 'Open handoff',
      ...(judges[0] !== undefined ? { judge_id: judges[0].id } : {}),
    }),
    slots: (id) => ({
      [`dashboard.panels.${id}.contact`]: 'The duty manager',
      [`dashboard.panels.${id}.reason`]: 'Anything the AI cannot decide confidently is routed here for a human check.',
      [`dashboard.panels.${id}.action_label`]: 'Open handoff',
    }),
  },
  kpi_tiles: {
    area: 'dashboard',
    build: () => ({
      type: 'kpi_tiles',
      id: 'kpi_headline',
      title: 'At a glance',
      metrics: [
        { label: 'Decisions', metric: 'decisions' },
        { label: 'Workflow runs', metric: 'runs' },
      ],
    }),
    slots: (id) => ({
      [`dashboard.panels.${id}.title`]: 'At a glance',
      [`dashboard.panels.${id}.metrics.0.label`]: 'Decisions',
      [`dashboard.panels.${id}.metrics.1.label`]: 'Workflow runs',
    }),
  },
  pipeline_tracker: {
    area: 'dashboard',
    build: (judges) => ({
      type: 'pipeline_tracker',
      id: 'pipeline',
      title: 'Progress',
      stages: [{ label: 'Received' }, { label: 'In review' }, { label: 'Done' }],
      ...(judges[0] !== undefined ? { current_judge_id: judges[0].id } : {}),
    }),
    slots: (id) => ({
      [`dashboard.panels.${id}.title`]: 'Progress',
      [`dashboard.panels.${id}.stages.0.label`]: 'Received',
      [`dashboard.panels.${id}.stages.1.label`]: 'In review',
      [`dashboard.panels.${id}.stages.2.label`]: 'Done',
    }),
  },
  status_queue: {
    area: 'dashboard',
    build: () => ({
      type: 'status_queue',
      id: 'work_queue',
      title: 'Work queue',
      rows: [
        { id: 'demo_row', label: 'Demo row — live rows appear once the queue is connected', source: 'manual', severity: 'low', state: 'pending' },
      ],
      actions: [
        { value: 'fulfil', label: 'Fulfil', primary: true },
        { value: 'not_yet', label: 'Not yet', primary: false },
      ],
    }),
    slots: (id) => ({
      [`dashboard.panels.${id}.title`]: 'Work queue',
      [`dashboard.panels.${id}.rows.demo_row.label`]: 'Demo row — live rows appear once the queue is connected',
      [`dashboard.panels.${id}.actions.fulfil.label`]: 'Fulfil',
      [`dashboard.panels.${id}.actions.not_yet.label`]: 'Not yet',
    }),
  },
  alert_feed: {
    area: 'dashboard',
    build: () => ({
      type: 'alert_feed',
      id: 'alerts',
      title: 'Alerts',
      alerts: [
        { id: 'demo_alert', title: 'Demo alert — aged items escalate automatically', source: 'system', age_days: 0, severity: 'low' },
      ],
      action_label: 'Review',
    }),
    slots: (id) => ({
      [`dashboard.panels.${id}.title`]: 'Alerts',
      [`dashboard.panels.${id}.alerts.demo_alert.title`]: 'Demo alert — aged items escalate automatically',
      [`dashboard.panels.${id}.action_label`]: 'Review',
    }),
  },
}

/** Bounded threshold band (recipe defaults ±0.1, never below review 0.5 /
 *  above auto 0.95, review strictly below auto). */
const THRESHOLD_LIMITS = { maxAuto: 0.95, minReview: 0.5, maxStep: 0.1, minGap: 0.05 }

function clampThreshold(current: number, proposed: unknown, min: number, max: number): number | null {
  if (typeof proposed !== 'number' || !Number.isFinite(proposed)) return null
  const stepped = Math.min(current + THRESHOLD_LIMITS.maxStep, Math.max(current - THRESHOLD_LIMITS.maxStep, proposed))
  const clamped = Math.min(max, Math.max(min, stepped))
  const rounded = Math.round(clamped * 100) / 100
  return Math.abs(rounded - current) < 0.005 ? null : rounded
}

/** Apply bounded threshold tweaks to one judge; returns null when nothing moved. */
function tweakThreshold(judge: Judge, tweak: { auto?: unknown; review?: unknown }): Judge | null {
  const next: Judge = { ...judge, thresholds: { ...judge.thresholds } }
  if (tweak.auto !== undefined) {
    const value = clampThreshold(judge.thresholds.auto, tweak.auto, judge.thresholds.review + THRESHOLD_LIMITS.minGap, THRESHOLD_LIMITS.maxAuto)
    if (value !== null) next.thresholds.auto = value
  }
  if (tweak.review !== undefined) {
    const value = clampThreshold(judge.thresholds.review, tweak.review, THRESHOLD_LIMITS.minReview, next.thresholds.auto - THRESHOLD_LIMITS.minGap)
    if (value !== null) next.thresholds.review = value
  }
  if (next.thresholds.auto === judge.thresholds.auto && next.thresholds.review === judge.thresholds.review) return null
  return next
}

// ---------------------------------------------------------------------------
// String-slot whitelist — computed from the CURRENT spec, so a proposal can
// only re-word what already exists (plus slots on catalogue components it
// just added). Covers every intake component and every dashboard panel with
// client-facing copy, wave modules included.
// ---------------------------------------------------------------------------

const SLOT_LIMITS: Record<string, number> = { name: 80, description: 400 }
const DEFAULT_SLOT_LIMIT = 300

/** Every re-wordable string slot in the spec, path → current value. */
export function stringSlots(spec: WorkflowSpec): Map<string, string> {
  const slots = new Map<string, string>()
  slots.set('name', spec.name)
  slots.set('description', spec.description)
  for (const component of spec.intake.components) {
    const prefix = `intake.components.${component.id}`
    switch (component.type) {
      case 'file_upload':
        slots.set(`${prefix}.label`, component.label)
        slots.set(`${prefix}.instructions`, component.instructions)
        break
      case 'chat':
        slots.set(`${prefix}.placeholder`, component.placeholder)
        slots.set(`${prefix}.opening_message`, component.opening_message)
        break
      case 'button_group':
        slots.set(`${prefix}.label`, component.label)
        for (const option of component.options) slots.set(`${prefix}.options.${option.value}.label`, option.label)
        break
      case 'text_field':
        slots.set(`${prefix}.label`, component.label)
        break
      case 'form':
        for (const field of component.fields) {
          slots.set(`${prefix}.fields.${field.id}.label`, field.label)
          if (field.type === 'select') {
            for (const option of field.options ?? []) slots.set(`${prefix}.fields.${field.id}.options.${option.value}.label`, option.label)
          }
        }
        break
      case 'photo_slot':
        slots.set(`${prefix}.label`, component.label)
        slots.set(`${prefix}.capture_hint`, component.capture_hint)
        break
      case 'follow_up_card':
        slots.set(`${prefix}.label`, component.label)
        slots.set(`${prefix}.question`, component.question)
        for (const option of component.options) slots.set(`${prefix}.options.${option.value}.label`, option.label)
        break
    }
  }
  for (const judge of spec.judges) slots.set(`judges.${judge.id}.question`, judge.question)
  for (const panel of spec.dashboard.panels) {
    const prefix = `dashboard.panels.${panel.id}`
    switch (panel.type) {
      case 'analysis':
      case 'thread_preview':
      case 'quote_panel':
      case 'kpi_tiles':
      case 'pipeline_tracker':
      case 'status_queue':
      case 'alert_feed':
        slots.set(`${prefix}.title`, panel.title)
        break
      default:
        break
    }
    switch (panel.type) {
      case 'confidence_meter':
      case 'usage_counter':
        slots.set(`${prefix}.label`, panel.label)
        break
      case 'quote_panel':
        slots.set(`${prefix}.basis`, panel.basis)
        panel.lines.forEach((line, index) => slots.set(`${prefix}.lines.${index}.label`, line.label))
        for (const band of panel.bands ?? []) slots.set(`${prefix}.bands.${band.value}.label`, band.label)
        break
      case 'escalation_card':
        slots.set(`${prefix}.contact`, panel.contact)
        slots.set(`${prefix}.reason`, panel.reason)
        if (panel.reference !== undefined) slots.set(`${prefix}.reference`, panel.reference)
        slots.set(`${prefix}.action_label`, panel.action_label)
        break
      case 'triage_verdict':
        for (const verdict of panel.verdicts) slots.set(`${prefix}.verdicts.${verdict.value}.label`, verdict.label)
        break
      case 'status_queue':
        for (const row of panel.rows) slots.set(`${prefix}.rows.${row.id}.label`, row.label)
        for (const action of panel.actions) slots.set(`${prefix}.actions.${action.value}.label`, action.label)
        break
      case 'alert_feed':
        for (const alert of panel.alerts) slots.set(`${prefix}.alerts.${alert.id}.title`, alert.title)
        slots.set(`${prefix}.action_label`, panel.action_label)
        break
      case 'kpi_tiles':
        panel.metrics.forEach((metric, index) => slots.set(`${prefix}.metrics.${index}.label`, metric.label))
        break
      case 'pipeline_tracker':
        panel.stages.forEach((stage, index) => slots.set(`${prefix}.stages.${index}.label`, stage.label))
        break
      default:
        break
    }
  }
  return slots
}

function setStringSlot(spec: WorkflowSpec, path: string, value: string): void {
  if (path === 'name') {
    spec.name = value
    return
  }
  if (path === 'description') {
    spec.description = value
    return
  }
  const componentMatch = path.match(/^intake\.components\.([a-z0-9_]+)\.(.+)$/)
  if (componentMatch !== null) {
    const component = spec.intake.components.find((entry) => entry.id === componentMatch[1])
    if (component === undefined) return
    const rest = componentMatch[2]
    const optionMatch = rest.match(/^options\.([a-z0-9_]+)\.label$/)
    if (optionMatch !== null && (component.type === 'button_group' || component.type === 'follow_up_card')) {
      const option = component.options.find((entry) => entry.value === optionMatch[1])
      if (option !== undefined) option.label = value
      return
    }
    const fieldOptionMatch = rest.match(/^fields\.([a-z0-9_]+)\.options\.([a-z0-9_]+)\.label$/)
    if (fieldOptionMatch !== null && component.type === 'form') {
      const field = component.fields.find((entry) => entry.id === fieldOptionMatch[1])
      if (field?.type === 'select') {
        const option = (field.options ?? []).find((entry) => entry.value === fieldOptionMatch[2])
        if (option !== undefined) option.label = value
      }
      return
    }
    const fieldMatch = rest.match(/^fields\.([a-z0-9_]+)\.label$/)
    if (fieldMatch !== null && component.type === 'form') {
      const field = component.fields.find((entry) => entry.id === fieldMatch[1])
      if (field !== undefined) field.label = value
      return
    }
    if (component.type === 'file_upload' && (rest === 'label' || rest === 'instructions')) {
      component[rest] = value
      return
    }
    if (component.type === 'chat' && (rest === 'placeholder' || rest === 'opening_message')) {
      component[rest] = value
      return
    }
    if (component.type === 'button_group' && rest === 'label') {
      component.label = value
      return
    }
    if (component.type === 'text_field' && rest === 'label') {
      component.label = value
      return
    }
    if (component.type === 'photo_slot' && (rest === 'label' || rest === 'capture_hint')) {
      component[rest] = value
      return
    }
    if (component.type === 'follow_up_card' && (rest === 'label' || rest === 'question')) {
      component[rest] = value
      return
    }
    return
  }
  const judgeMatch = path.match(/^judges\.([a-z0-9_]+)\.question$/)
  if (judgeMatch !== null) {
    const judge = spec.judges.find((entry) => entry.id === judgeMatch[1])
    if (judge !== undefined) judge.question = value
    return
  }
  const panelMatch = path.match(/^dashboard\.panels\.([a-z0-9_]+)\.(.+)$/)
  if (panelMatch !== null) {
    const panel = spec.dashboard.panels.find((entry) => entry.id === panelMatch[1])
    if (panel === undefined) return
    const rest = panelMatch[2]
    // Scalar leaf fields (title / label / basis / contact / reason / …).
    const leafFields = ['title', 'label', 'basis', 'contact', 'reason', 'reference', 'action_label'] as const
    if ((leafFields as readonly string[]).includes(rest)) {
      if (rest === 'title' && 'title' in panel) panel.title = value
      else if (rest === 'label' && (panel.type === 'confidence_meter' || panel.type === 'usage_counter')) panel.label = value
      else if (rest === 'basis' && panel.type === 'quote_panel') panel.basis = value
      else if (panel.type === 'escalation_card' && (rest === 'contact' || rest === 'reason' || rest === 'reference' || rest === 'action_label')) {
        if (rest === 'reference') {
          panel.reference = value
        } else {
          panel[rest] = value
        }
      }
      return
    }
    // Indexed / keyed sub-object labels.
    const verdictMatch = rest.match(/^verdicts\.([a-z0-9_]+)\.label$/)
    if (verdictMatch !== null && panel.type === 'triage_verdict') {
      const verdict = panel.verdicts.find((entry) => entry.value === verdictMatch[1])
      if (verdict !== undefined) verdict.label = value
      return
    }
    const bandMatch = rest.match(/^bands\.([a-z0-9_]+)\.label$/)
    if (bandMatch !== null && panel.type === 'quote_panel') {
      const band = (panel.bands ?? []).find((entry) => entry.value === bandMatch[1])
      if (band !== undefined) band.label = value
      return
    }
    const lineMatch = rest.match(/^lines\.(\d+)\.label$/)
    if (lineMatch !== null && panel.type === 'quote_panel') {
      const line = panel.lines[Number(lineMatch[1])]
      if (line !== undefined) line.label = value
      return
    }
    const rowMatch = rest.match(/^rows\.([a-z0-9_]+)\.label$/)
    if (rowMatch !== null && panel.type === 'status_queue') {
      const row = panel.rows.find((entry) => entry.id === rowMatch[1])
      if (row !== undefined) row.label = value
      return
    }
    const actionMatch = rest.match(/^actions\.([a-z0-9_]+)\.label$/)
    if (actionMatch !== null && panel.type === 'status_queue') {
      const action = panel.actions.find((entry) => entry.value === actionMatch[1])
      if (action !== undefined) action.label = value
      return
    }
    const alertMatch = rest.match(/^alerts\.([a-z0-9_]+)\.title$/)
    if (alertMatch !== null && panel.type === 'alert_feed') {
      const alert = panel.alerts.find((entry) => entry.id === alertMatch[1])
      if (alert !== undefined) alert.title = value
      return
    }
    const metricMatch = rest.match(/^metrics\.(\d+)\.label$/)
    if (metricMatch !== null && panel.type === 'kpi_tiles') {
      const metric = panel.metrics[Number(metricMatch[1])]
      if (metric !== undefined) metric.label = value
      return
    }
    const stageMatch = rest.match(/^stages\.(\d+)\.label$/)
    if (stageMatch !== null && panel.type === 'pipeline_tracker') {
      const stage = panel.stages[Number(stageMatch[1])]
      if (stage !== undefined) stage.label = value
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic applier — validates every key, clamps every number, keeps at
// least one intake component. Returns the new spec plus the list of applied
// changes (used for the plain-language diff when the planner's own summary
// is unusable).
// ---------------------------------------------------------------------------

export function applyProposal(current: WorkflowSpec, proposal: PlannerProposal): { spec: WorkflowSpec; applied: string[] } {
  const spec: WorkflowSpec = {
    ...current,
    intake: { components: current.intake.components.map((component) => structuredClone(component)) },
    judges: current.judges.map((judge) => ({ ...judge, thresholds: { ...judge.thresholds }, ...(judge.options !== undefined ? { options: [...judge.options] } : {}) })),
    // Panels deep-cloned: nested rows/lines/alerts are mutated in place below.
    dashboard: { panels: current.dashboard.panels.map((panel) => structuredClone(panel)) },
  }
  const applied: string[] = []

  // --- Structural ops (catalogue only) ---
  for (const op of proposal.componentOps ?? []) {
    const entry = CATALOGUE[op.component]
    if (entry === undefined) continue
    if (entry.area === 'intake') {
      const hasKind = spec.intake.components.some((component) => component.type === op.component)
      if (op.op === 'add' && !hasKind) {
        spec.intake.components.push(entry.build())
        applied.push(`added the ${op.component.replace(/_/g, ' ')} step`)
      }
      if (op.op === 'remove' && hasKind && spec.intake.components.length > 1) {
        spec.intake.components = spec.intake.components.filter((component) => component.type !== op.component)
        applied.push(`removed the ${op.component.replace(/_/g, ' ')} step`)
      }
    } else {
      const hasKind = spec.dashboard.panels.some((panel) => panel.type === op.component)
      if (op.op === 'add' && !hasKind) {
        const built = entry.build(spec.judges)
        if (built !== null) {
          spec.dashboard.panels.push(built)
          applied.push(`added the ${op.component.replace(/_/g, ' ')} panel`)
        }
      }
      if (op.op === 'remove' && hasKind && !ALWAYS_ON_PANELS.has(op.component)) {
        spec.dashboard.panels = spec.dashboard.panels.filter((panel) => panel.type !== op.component)
        applied.push(`removed the ${op.component.replace(/_/g, ' ')} panel`)
      }
    }
  }
  // An intake surface must exist; chat is the universal intake.
  if (spec.intake.components.length === 0) {
    const chatEntry = CATALOGUE.chat
    if (chatEntry.area === 'intake') spec.intake.components.push(chatEntry.build())
    applied.push('added the chat step')
  }

  // --- String slots (whitelist; catalogue defaults for newly added parts) ---
  const whitelist = stringSlots(spec)
  for (const component of spec.intake.components) {
    const entry = CATALOGUE[component.type]
    if (entry === undefined || entry.area !== 'intake') continue
    for (const [path, value] of Object.entries(entry.slots(component.id))) {
      if (!whitelist.has(path)) whitelist.set(path, value)
    }
  }
  for (const [path, value] of Object.entries(proposal.strings ?? {})) {
    if (!whitelist.has(path) || typeof value !== 'string') continue
    const trimmed = value.trim()
    const limit = SLOT_LIMITS[path] ?? DEFAULT_SLOT_LIMIT
    if (trimmed.length === 0 || trimmed.length > limit) continue
    const before = whitelist.get(path)
    if (before === trimmed) continue
    setStringSlot(spec, path, trimmed)
    applied.push(`changed ${humanisePath(path)}`)
  }

  // --- Bounded threshold tweaks ---
  for (const tweak of proposal.thresholdTweaks ?? []) {
    const judge = spec.judges.find((entry) => entry.id === tweak.judgeId)
    if (judge === undefined) continue
    const tweaked = tweakThreshold(judge, tweak)
    if (tweaked === null) continue
    judge.thresholds = tweaked.thresholds
    applied.push(
      `adjusted the ${tweak.judgeId.replace(/_/g, ' ')} thresholds (auto ${judge.thresholds.auto}, review ${judge.thresholds.review})`,
    )
  }

  return { spec, applied }
}

/** "intake.components.photo_slot.instructions" → "the photo slot instructions". */
function humanisePath(path: string): string {
  if (path === 'name') return 'the workflow name'
  if (path === 'description') return 'the workflow description'
  const judge = path.match(/^judges\.([a-z0-9_]+)\.question$/)
  if (judge !== null) return `the “${judge[1].replace(/_/g, ' ')}” question`
  const panel = path.match(/^dashboard\.panels\.([a-z0-9_]+)\.(.+)$/)
  if (panel !== null) return `the ${panel[1].replace(/_/g, ' ')} panel ${panel[2].replace(/_/g, ' ')}`
  const option = path.match(/^intake\.components\.([a-z0-9_]+)\.options\.([a-z0-9_]+)\.label$/)
  if (option !== null) return `the “${option[2].replace(/_/g, ' ')}” option`
  const field = path.match(/^intake\.components\.([a-z0-9_]+)\.fields\.([a-z0-9_]+)\.label$/)
  if (field !== null) return `the “${field[2].replace(/_/g, ' ')}” field label`
  const component = path.match(/^intake\.components\.([a-z0-9_]+)\.(.+)$/)
  if (component !== null) return `the ${component[1].replace(/_/g, ' ')} ${component[2].replace(/_/g, ' ')}`
  const leaf = path.split('.').pop() ?? ''
  return `the ${leaf.replace(/_/g, ' ')} text`
}

// ---------------------------------------------------------------------------
// v1 planner: GLM-5.3-Flash (Z.ai, plain fetch). One call returns the whole
// proposal as JSON; the applier is the only code that touches the spec.
// ---------------------------------------------------------------------------

function glmPlanner(): SpecPlanner {
  return {
    name: 'glm-5.3-flash',
    async plan(input) {
      const slots = stringSlots(input.currentSpec)
      const offered = [...slots.entries()]
        .map(([path, value]) => `"${path}": "${value.replace(/"/g, '\\"')}"`)
        .join(',\n')
      const intakeKinds = INTAKE_KINDS.map((kind) => {
        const present = input.currentSpec.intake.components.some((component) => component.type === kind)
        return `${kind} (${present ? 'present' : 'absent'})`
      }).join(', ')
      const panelKinds = PANEL_KINDS.map((kind) => {
        const present = input.currentSpec.dashboard.panels.some((panel) => panel.type === kind)
        return `${kind} (${present ? 'present' : 'absent'})`
      }).join(', ')
      const judges = input.currentSpec.judges
        .map((judge) => `${judge.id} (auto ${judge.thresholds.auto}, review ${judge.thresholds.review})`)
        .join('; ') || 'none'

      const user = [
        'You are the workflow-edit planner for Connective Sandbox. A client sent feedback about their intake workflow.',
        `FEEDBACK CLASSIFICATION: ${input.classification}`,
        `CLIENT FEEDBACK:\n"""${input.feedback.slice(0, 2000)}"""`,
        `CURRENT SPEC:\n${JSON.stringify(input.currentSpec).slice(0, 6000)}`,
        'RULES:',
        `- string_edits may ONLY use the slot paths offered below (you may leave any untouched). Values are plain client-facing English (Singapore English), short.`,
        `- component_ops may ONLY add/remove: intake components — ${intakeKinds}; dashboard panels — ${panelKinds}. Never remove the last remaining intake component. The decision_log and usage_counter panels always stay.`,
        `- threshold_tweaks may only nudge a judge's auto/review by at most 0.1; auto stays at or below 0.95, review stays at or above 0.5, review stays below auto. Use threshold tweaks ONLY when the feedback is clearly about decision confidence, never for wording complaints.`,
        '- summary: one plain-language sentence describing the proposed change for a non-technical service rep (e.g. "changed quote validity to 14 days; added an escalation card").',
        'Reply with ONE JSON object and NOTHING else, shaped exactly:',
        '{"string_edits": {"<slot path>": "<new text>"}, "component_ops": [{"op": "add|remove", "component": "<kind>"}], "threshold_tweaks": [{"judgeId": "<id>", "auto": 0.9, "review": 0.5}], "summary": "<sentence>"}',
        `SLOT PATHS (path: current value):\n${offered}`,
        `JUDGES: ${judges}`,
      ].join('\n\n')

      const content = await glmChat(
        [
          { role: 'system', content: 'You propose bounded edits to a fixed workflow spec. Output one JSON object only.' },
          { role: 'user', content: user },
        ],
        { maxTokens: 3072, reasoningEffort: 'low' },
      )

      const map = extractJsonMap(content)
      if (map === null) throw new Error('Planner reply was not valid JSON')
      const strings: Record<string, string> = {}
      for (const [key, value] of Object.entries(map.string_edits ?? {})) {
        if (typeof value === 'string') strings[key] = value
      }
      const componentOps = (Array.isArray(map.component_ops) ? map.component_ops : [])
        .filter((op): op is { op: 'add' | 'remove'; component: ComponentKind } =>
          typeof op?.op === 'string' && (op.op === 'add' || op.op === 'remove') &&
          typeof op?.component === 'string' && COMPONENT_KINDS.includes(op.component as ComponentKind))
      const thresholdTweaks = (Array.isArray(map.threshold_tweaks) ? map.threshold_tweaks : [])
        .filter((tweak): tweak is { judgeId: string; auto?: number; review?: number } =>
          typeof tweak?.judgeId === 'string')
      return {
        strings,
        componentOps,
        thresholdTweaks,
        summary: typeof map.summary === 'string' && map.summary.trim().length > 0 ? map.summary.trim().slice(0, 300) : '',
      }
    },
  }
}

function extractJsonMap(content: string): Record<string, unknown> | null {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  const candidates = [fenced.map((match) => match[1]?.trim()).filter((value): value is string => value !== undefined), [content]].flat()
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

/** A planner that never proposes anything (drafting disabled). */
function nullPlanner(): SpecPlanner {
  return {
    name: 'none',
    async plan() {
      return { strings: {}, componentOps: [], thresholdTweaks: [], summary: '' }
    },
  }
}

/** Resolve the planner from the PLANNER_ADAPTER secret ('glm' default). */
export function resolvePlanner(): SpecPlanner {
  return Deno.env.get('PLANNER_ADAPTER') === 'none' ? nullPlanner() : glmPlanner()
}
