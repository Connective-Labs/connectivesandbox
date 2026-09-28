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

import type { Judge, WorkflowSpec } from '../../../src/engine/types.ts'
import { glmChat } from '../_shared/glm.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComponentKind = 'file_upload' | 'chat' | 'form' | 'button_group' | 'text_field'

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
// Deterministic catalogue — legal parts only (docs/modules.md), shared with
// the live-draft brain. Component ids, option sets and default strings are
// catalogue values; a planner may only add/remove whole components.
// ---------------------------------------------------------------------------

export const COMPONENT_KINDS: ComponentKind[] = [
  'file_upload',
  'chat',
  'form',
  'button_group',
  'text_field',
]

interface CatalogueComponent {
  kind: ComponentKind
  build: () => WorkflowSpec['intake']['components'][number]
  slots: (id: string) => Record<string, string>
}

export const CATALOGUE: Record<ComponentKind, CatalogueComponent> = {
  file_upload: {
    kind: 'file_upload',
    build: () => ({
      type: 'file_upload',
      id: 'photo_slot',
      label: 'Photos of the item',
      accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
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
    kind: 'chat',
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
    kind: 'form',
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
    kind: 'button_group',
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
    kind: 'text_field',
    build: () => ({
      type: 'text_field',
      id: 'short_note',
      label: 'Anything else we should know?',
      multiline: false,
    }),
    slots: (id) => ({ [`intake.components.${id}.label`]: 'Anything else we should know?' }),
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
// just added).
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
    }
  }
  for (const judge of spec.judges) slots.set(`judges.${judge.id}.question`, judge.question)
  for (const panel of spec.dashboard.panels) {
    if (panel.type === 'analysis') slots.set(`dashboard.panels.${panel.id}.title`, panel.title)
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
    if (optionMatch !== null && component.type === 'button_group') {
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
    return
  }
  const judgeMatch = path.match(/^judges\.([a-z0-9_]+)\.question$/)
  if (judgeMatch !== null) {
    const judge = spec.judges.find((entry) => entry.id === judgeMatch[1])
    if (judge !== undefined) judge.question = value
    return
  }
  const panelMatch = path.match(/^dashboard\.panels\.([a-z0-9_]+)\.title$/)
  if (panelMatch !== null) {
    const panel = spec.dashboard.panels.find((entry) => entry.id === panelMatch[1])
    if (panel !== undefined && panel.type === 'analysis') panel.title = value
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
    dashboard: { panels: current.dashboard.panels.map((panel) => ({ ...panel })) },
  }
  const applied: string[] = []

  // --- Structural ops (catalogue only) ---
  for (const op of proposal.componentOps ?? []) {
    if (CATALOGUE[op.component] === undefined) continue
    const hasKind = spec.intake.components.some((component) => component.type === op.component)
    if (op.op === 'add' && !hasKind) {
      const built = CATALOGUE[op.component].build()
      spec.intake.components.push(built)
      applied.push(`added the ${op.component.replace('_', ' ')} step`)
    }
    if (op.op === 'remove' && hasKind && spec.intake.components.length > 1) {
      spec.intake.components = spec.intake.components.filter((component) => component.type !== op.component)
      applied.push(`removed the ${op.component.replace('_', ' ')} step`)
    }
  }
  // An intake surface must exist; chat is the universal intake.
  if (spec.intake.components.length === 0) {
    spec.intake.components.push(CATALOGUE.chat.build())
    applied.push('added the chat step')
  }

  // --- String slots (whitelist; catalogue defaults for newly added parts) ---
  const whitelist = stringSlots(spec)
  for (const component of spec.intake.components) {
    for (const [path, value] of Object.entries(CATALOGUE[component.type].slots(component.id))) {
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
  const panel = path.match(/^dashboard\.panels\.([a-z0-9_]+)\.title$/)
  if (panel !== null) return `the “${panel[1].replace(/_/g, ' ')}” panel title`
  const option = path.match(/^intake\.components\.([a-z0-9_]+)\.options\.([a-z0-9_]+)\.label$/)
  if (option !== null) return `the “${option[2].replace(/_/g, ' ')}” option`
  const field = path.match(/^intake\.components\.([a-z0-9_]+)\.fields\.([a-z0-9_]+)\.label$/)
  if (field !== null) return `the “${field[2].replace(/_/g, ' ')}” field label`
  const leaf = path.split('.').pop() ?? ''
  return `the ${leaf} text`
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
      const kinds = COMPONENT_KINDS.map((kind) => {
        const present = input.currentSpec.intake.components.some((component) => component.type === kind)
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
        `- component_ops may ONLY add/remove these whole components: ${kinds}. Never remove the last remaining component.`,
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
