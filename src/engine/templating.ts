// Template slots — the parameterisation layer behind the reusable workflow
// library (save-as-template / instantiate). A template stores its curated
// WorkflowSpec plus the FULL list of rewordable slots (every client-facing
// display string and every judge threshold) with the source workflow's value
// as the example. Instantiation applies rep-edited slot values
// deterministically: strings are length-bounded, thresholds clamp to ±0.1 of
// the example inside the global band, and the frozen Zod schema stays the
// hard gate in the caller. Closed option VALUES, accept lists, metric names,
// and ids are never slots — the structure is the library's, only the copy and
// the calibration are per-client.
//
// This module is also the canonical string-slot walk: the feedback planner's
// whitelist and the template machinery share it. Pure module.

import type { Judge, WorkflowSpec } from './types.ts'

export type TemplateSlotType = 'string' | 'threshold_auto' | 'threshold_review'
export type TemplateSlotGroup = 'identity' | 'intake' | 'judges' | 'dashboard'

export interface TemplateSlot {
  /** Slot path, e.g. `intake.components.photo_slot.label` or
   *  `judges.decision_judge.thresholds.auto`. */
  key: string
  label: string
  type: TemplateSlotType
  group: TemplateSlotGroup
  /** The source workflow's value — pre-fills the instantiate form. */
  example: string | number
}

const SLOT_LIMITS: Record<string, number> = { name: 80, description: 400 }
const DEFAULT_SLOT_LIMIT = 300
const THRESHOLD_LIMITS = { maxAuto: 0.95, minReview: 0.5, maxStep: 0.1, minGap: 0.05 }

/** Every re-wordable string slot in the spec, path → current value. */
export function specStringSlots(spec: WorkflowSpec): Map<string, string> {
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

/** All template slots: identity, every string slot, every threshold. */
export function templateSlots(spec: WorkflowSpec): TemplateSlot[] {
  const slots: TemplateSlot[] = [
    { key: 'name', label: 'Workflow name', type: 'string', group: 'identity', example: spec.name },
    { key: 'description', label: 'Workflow description', type: 'string', group: 'identity', example: spec.description },
  ]
  const groupFor = (path: string): TemplateSlotGroup =>
    path.startsWith('intake.') ? 'intake' : path.startsWith('judges.') ? 'judges' : 'dashboard'
  for (const [path, value] of specStringSlots(spec)) {
    if (path === 'name' || path === 'description') continue
    slots.push({ key: path, label: humaniseSlotKey(path), type: 'string', group: groupFor(path), example: value })
  }
  for (const judge of spec.judges) {
    slots.push({
      key: `judges.${judge.id}.thresholds.auto`,
      label: `${humaniseSlotKey(`judges.${judge.id}.question`).replace(' question', '')} auto threshold`,
      type: 'threshold_auto',
      group: 'judges',
      example: judge.thresholds.auto,
    })
    slots.push({
      key: `judges.${judge.id}.thresholds.review`,
      label: `${humaniseSlotKey(`judges.${judge.id}.question`).replace(' question', '')} review threshold`,
      type: 'threshold_review',
      group: 'judges',
      example: judge.thresholds.review,
    })
  }
  return slots
}

function clampThreshold(current: number, proposed: unknown, min: number, max: number): number | null {
  if (typeof proposed !== 'number' || !Number.isFinite(proposed)) return null
  const stepped = Math.min(current + THRESHOLD_LIMITS.maxStep, Math.max(current - THRESHOLD_LIMITS.maxStep, proposed))
  const clamped = Math.min(max, Math.max(min, stepped))
  const rounded = Math.round(clamped * 100) / 100
  return Math.abs(rounded - current) < 0.005 ? null : rounded
}

/** Set one string slot by path. Canonical setter shared by the planner and
 *  the template machinery; unknown paths are ignored. */
export function setStringByPath(spec: WorkflowSpec, path: string, value: string): void {
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

/**
 * Apply slot values to a spec. Deterministic and bounded: only known slot
 * paths apply, strings are length-limited, thresholds clamp to ±0.1 of the
 * slot's example inside the global band. Returns the new spec (the input is
 * never mutated) plus the human-readable list of applied changes.
 */
export function applySlotValues(
  current: WorkflowSpec,
  slots: TemplateSlot[],
  values: Record<string, string | number>,
): { spec: WorkflowSpec; applied: string[] } {
  const spec: WorkflowSpec = {
    ...current,
    intake: { components: current.intake.components.map((component) => structuredClone(component)) },
    judges: current.judges.map((judge) => ({ ...judge, thresholds: { ...judge.thresholds }, ...(judge.options !== undefined ? { options: [...judge.options] } : {}) })),
    dashboard: { panels: current.dashboard.panels.map((panel) => structuredClone(panel)) },
  }
  const known = new Map(slots.map((slot) => [slot.key, slot]))
  const applied: string[] = []
  for (const [key, rawValue] of Object.entries(values)) {
    const slot = known.get(key)
    if (slot === undefined) continue
    if (slot.type === 'string') {
      if (typeof rawValue !== 'string') continue
      const trimmed = rawValue.trim()
      const limit = SLOT_LIMITS[key] ?? DEFAULT_SLOT_LIMIT
      if (trimmed.length === 0 || trimmed.length > limit) continue
      if (trimmed === slot.example) continue
      setStringByPath(spec, key, trimmed)
      applied.push(`changed ${slot.label.toLowerCase()}`)
      continue
    }
    // Thresholds: clamp ±0.1 of the example inside the global band, then
    // enforce review < auto against the FINAL pairing.
    const isAuto = slot.type === 'threshold_auto'
    const judgeId = key.match(/^judges\.([a-z0-9_]+)\.thresholds\./)?.[1]
    const judge = spec.judges.find((entry) => entry.id === judgeId)
    if (judge === undefined) continue
    const example = typeof slot.example === 'number' ? slot.example : 0.9
    const clamped = clampThreshold(
      example,
      rawValue,
      isAuto ? judge.thresholds.review + THRESHOLD_LIMITS.minGap : THRESHOLD_LIMITS.minReview,
      isAuto ? THRESHOLD_LIMITS.maxAuto : judge.thresholds.auto - THRESHOLD_LIMITS.minGap,
    )
    if (clamped === null) continue
    judge.thresholds[isAuto ? 'auto' : 'review'] = clamped
    if (judge.thresholds.review >= judge.thresholds.auto) {
      // Never leave an inverted pair; revert this tweak.
      judge.thresholds[isAuto ? 'auto' : 'review'] = example
      continue
    }
    applied.push(`adjusted ${slot.label.toLowerCase()} to ${clamped}`)
  }
  return { spec, applied }
}

/** "intake.components.photo_slot.capture_hint" → "Photo slot capture hint". */
export function humaniseSlotKey(path: string): string {
  if (path === 'name') return 'Workflow name'
  if (path === 'description') return 'Workflow description'
  const judge = path.match(/^judges\.([a-z0-9_]+)\.question$/)
  if (judge !== null) return `The ${judge[1].replace(/_/g, ' ')} question`
  const threshold = path.match(/^judges\.([a-z0-9_]+)\.thresholds\.(auto|review)$/)
  if (threshold !== null) return `The ${threshold[1].replace(/_/g, ' ')} ${threshold[2]} threshold`
  const panel = path.match(/^dashboard\.panels\.([a-z0-9_]+)\.(.+)$/)
  if (panel !== null) return `The ${panel[1].replace(/_/g, ' ')} ${panel[2].replace(/[._]/g, ' ')}`
  const option = path.match(/^intake\.components\.([a-z0-9_]+)\.options\.([a-z0-9_]+)\.label$/)
  if (option !== null) return `The ${option[2].replace(/_/g, ' ')} option`
  const field = path.match(/^intake\.components\.([a-z0-9_]+)\.fields\.([a-z0-9_]+)\.label$/)
  if (field !== null) return `The ${field[2].replace(/_/g, ' ')} field label`
  const component = path.match(/^intake\.components\.([a-z0-9_]+)\.(.+)$/)
  if (component !== null) return `The ${component[1].replace(/_/g, ' ')} ${component[2].replace(/[._]/g, ' ')}`
  const leaf = path.split('.').pop() ?? ''
  return `The ${leaf.replace(/_/g, ' ')}`
}

/** Judge type helper re-exported for callers (threshold slots need judges). */
export type { Judge }
