// The catalogue — the closed vocabulary of the fact ledger and the compiled
// specs. Every legal fact key, option set, threshold, and default string
// lives here. Nothing outside this file can mint a structure the compilers
// emit, which is WHY the compiler cannot produce duplicates or invalid
// structure: keys are closed, elements are one-per-key by construction.
//
// Mirrors the module catalogue in docs/modules.md. Pure module.
//
// Wave parity (2026-09-30): the key space covers the module waves —
// `intake.photo` compiles the keyed photo_slot, `intake.files` the generic
// file upload, `intake.follow_up` the pre-authored clarification card; the
// photo-triage judge chain (archetype, follow-up, price band) and every wave
// dashboard panel compile from their own keys; `operations-desk` is a real
// recipe (route decision set), not an alias.

import type { FactArea, FactDetail, LedgerFact } from './facts.ts'

// ---------------------------------------------------------------------------
// Decision sets (closed option sets for choice judges)
// ---------------------------------------------------------------------------

export interface DecisionSet {
  /** Closed option set for the decision judge, in display order. */
  options: string[]
  /** Worst option → the human handoff (escalation path). */
  worst: string
  /** Default decision-judge question wording (GLM may re-word once, at creation). */
  question: string
}

export const DECISION_SETS: Record<string, DecisionSet> = {
  quote_or_visit: {
    options: ['quotable', 'one_ask', 'site_visit', 'uncertain'],
    worst: 'uncertain',
    question: 'Based on what the client submitted, what is the disposition?',
  },
  approve_reject: {
    options: ['approve', 'reject', 'escalate'],
    worst: 'escalate',
    question: 'Should this submission be approved or rejected?',
  },
  complete_incomplete: {
    options: ['complete', 'incomplete', 'escalate'],
    worst: 'escalate',
    question: 'Is the submitted information complete enough to proceed?',
  },
  route: {
    options: ['self_serve', 'automated', 'human_escalate'],
    worst: 'human_escalate',
    question: 'How should this item be handled?',
  },
  price_band: {
    options: ['band_a', 'band_b', 'band_c', 'needs_visit'],
    worst: 'needs_visit',
    question: 'Which price band does this job fall into?',
  },
}

/** Deterministic thresholds. 0.85 is the sanctioned legibility exception. */
export const THRESHOLDS_STANDARD = { auto: 0.9, review: 0.5 } as const
export const THRESHOLDS_QUALITY = { auto: 0.85, review: 0.5 } as const

/** Closed option sets for the fixed photo-triage chain judges. */
export const ARCHETYPE_OPTIONS = ['standard', 'delicate', 'specialist'] as const
export const FOLLOW_UP_OPTIONS = ['photos_needed', 'visit_needed', 'details_needed', 'none'] as const

// ---------------------------------------------------------------------------
// Fact key space — the ONLY keys the classifier may emit
// ---------------------------------------------------------------------------

/** The intake classes (docs/modules.md), wave modules included. */
export const INTAKE_KEYS = [
  'intake.photo',
  'intake.files',
  'intake.chat',
  'intake.form',
  'intake.follow_up',
  'intake.request_kind',
  'intake.notes',
] as const

/** The judge classes. */
export const JUDGE_KEYS = [
  'judge.decision',
  'judge.escalation',
  'judge.quality',
  'judge.archetype',
  'judge.follow_up',
  'judge.price_band',
] as const

/** Dashboard facts (log + usage panels are always-on and need no fact). */
export const DASHBOARD_KEYS = [
  'dashboard.summary',
  'dashboard.metrics',
  'dashboard.triage_verdict',
  'dashboard.quote',
  'dashboard.thread',
  'dashboard.escalation',
  'dashboard.queue',
  'dashboard.alerts',
  'dashboard.kpi',
  'dashboard.pipeline',
] as const

/** All structural keys (option facts are additional, see factKeyMatches). */
export const STRUCTURAL_KEYS: readonly string[] = [...INTAKE_KEYS, ...JUDGE_KEYS, ...DASHBOARD_KEYS]

/** Area for a structural key. */
export function areaForKey(key: string): FactArea | null {
  if ((INTAKE_KEYS as readonly string[]).includes(key)) return 'intake'
  if ((JUDGE_KEYS as readonly string[]).includes(key)) return 'judges'
  if ((DASHBOARD_KEYS as readonly string[]).includes(key)) return 'dashboard'
  return null
}

/**
 * A key is legal when it is structural, or an option fact:
 * `judge.decision.options.<opt>` with <opt> in the catalogue decision sets.
 * Option facts are how a closed decision set is narrowed without ever
 * inventing an open-ended option.
 */
export function factKeyMatches(key: string): boolean {
  if (areaForKey(key) !== null) return true
  const match = key.match(/^judge\.decision\.options\.([a-z0-9_]+)$/)
  if (match === null) return false
  return Object.values(DECISION_SETS).some((set) => set.options.includes(match[1]))
}

/** Legal classification ops per question (openjev answers, closed sets). */
export const FACT_OP_OPTIONS = ['add', 'update', 'confirm', 'remove', 'no_change'] as const

// ---------------------------------------------------------------------------
// Rubric lines — one per key, shown to the classifier
// ---------------------------------------------------------------------------

export const KEY_RUBRICS: Record<string, string> = {
  'intake.photo': 'keyed photo capture per item — the customer photographs the item with capture hints (rail in frame, fabric tag)',
  'intake.files': 'general document/file upload (claims packs, compliance documents, scans)',
  'intake.chat': 'conversational free-form intake — the end user describes the job in their own words',
  'intake.form': 'structured multi-field record at intake (dates, reference numbers, quantities)',
  'intake.follow_up': 'a pre-authored clarification card — one question with choice chips the customer taps to unblock the job',
  'intake.request_kind': 'one-tap closed choice for the end user (request kind, category)',
  'intake.notes': 'short typed note from the end user',
  'judge.decision': 'the closed-set decision judge (quote or visit, approve or reject, complete or incomplete, route)',
  'judge.escalation': 'a yes/no judge for when a human must look before anything happens',
  'judge.quality': 'a 0–1 legibility/completeness score judge for submissions that may be blurry or incomplete',
  'judge.archetype': 'a closed-set item-type judge (standard, delicate, specialist) that routes handling',
  'judge.follow_up': 'a closed-set judge for which single follow-up ask unblocks the job',
  'judge.price_band': 'the closed-set price-band judge (band A, B, C, or needs a visit)',
  'dashboard.summary': 'a narrative summary panel on the dashboard',
  'dashboard.metrics': 'an ops metrics tile on the dashboard',
  'dashboard.triage_verdict': 'the big verdict card showing the decision judge outcome',
  'dashboard.quote': 'the draft quote card with price bands and a non-hourly basis footnote',
  'dashboard.thread': 'the joined conversation view (photo → question → answer → quote)',
  'dashboard.escalation': 'the human-handoff card with named contact and context',
  'dashboard.queue': 'the sortable work queue with exactly two actions per row',
  'dashboard.alerts': 'the ranked alert feed for what is overdue or going wrong',
  'dashboard.kpi': 'headline KPI tiles',
  'dashboard.pipeline': 'the stage tracker (received → in review → done)',
}

// ---------------------------------------------------------------------------
// Default strings per key — catalogue fallbacks; GLM fills these slots once
// per newly created element and the strings cache on the fact thereafter.
// ---------------------------------------------------------------------------

export const DEFAULT_STRINGS: Record<string, Record<string, string>> = {
  'intake.photo': {
    label: 'Photos of the item',
    capture_hint: 'Include the whole item in frame — sharp, well-lit, no clutter.',
  },
  'intake.files': {
    label: 'Documents',
    instructions: 'Upload the complete document — every page, sharp and readable.',
  },
  'intake.chat': {
    placeholder: 'Describe what you need…',
    opening_message: 'Tell us about the job and attach photos where helpful.',
  },
  'intake.form': {
    question: 'Describe the job in your own words',
  },
  'intake.follow_up': {
    label: 'One quick question',
    question: 'Which of these would unblock the job?',
  },
  'intake.request_kind': {
    label: 'What kind of request is this?',
  },
  'intake.notes': {
    label: 'Anything else we should know?',
  },
  'judge.decision': {
    question: DECISION_SETS.quote_or_visit.question,
  },
  'judge.escalation': {
    question: 'Does this submission need a person to look at it before we act?',
  },
  'judge.quality': {
    question: 'How legible and complete is the submission, from 0 to 1?',
  },
  'judge.archetype': {
    question: 'What kind of item is this?',
  },
  'judge.follow_up': {
    question: 'Which single follow-up would unblock this job?',
  },
  'judge.price_band': {
    question: DECISION_SETS.price_band.question,
  },
  'dashboard.summary': {
    title: 'Summary',
  },
  'dashboard.metrics': {
    title: 'Operations',
  },
  'dashboard.quote': {
    title: 'Draft quote',
    basis: 'Priced on job characteristics, never hours.',
  },
  'dashboard.thread': {
    title: 'How it went',
  },
  'dashboard.escalation': {
    contact: 'The duty specialist',
    reason: 'Anything the AI cannot decide confidently comes here for a human check.',
    action_label: 'Open handoff',
  },
  'dashboard.queue': {
    title: 'Work queue',
  },
  'dashboard.alerts': {
    title: 'Alerts',
    action_label: 'Review',
  },
  'dashboard.kpi': {
    title: 'At a glance',
  },
  'dashboard.pipeline': {
    title: 'Progress',
  },
}

/** Workflow name/description per recipe — stable across regenerations (draft
 *  stability + the preview delta never remounts on a rename). */
export const WORKFLOW_TITLES: Record<string, { name: string; description: string }> = {
  generic: {
    name: 'Live-drafted workflow',
    description: 'Drafted from a live discovery call; reviewed by the rep before publishing.',
  },
}

// ---------------------------------------------------------------------------
// Recipes — named patterns (docs/modules.md). Seeds are the baseline facts a
// session starts from; the classifier confirms, updates, removes, or adds on
// top of them.
// ---------------------------------------------------------------------------

export type RecipeId = 'photo-triage' | 'document-intake' | 'approval-desk' | 'operations-desk' | 'generic'

/** Unknown ids fall back to generic. 'operations-desk' is a REAL recipe
 *  (route decision set) — the old approval-desk alias is gone. */
export function normaliseRecipeId(recipeId: string | null | undefined): RecipeId {
  if (
    recipeId === 'photo-triage' ||
    recipeId === 'document-intake' ||
    recipeId === 'approval-desk' ||
    recipeId === 'operations-desk'
  ) {
    return recipeId
  }
  return 'generic'
}

/** Match a workflow name (RecipePicker names) to a recipe. */
export function recipeFromName(name: string): RecipeId {
  const lowered = name.toLowerCase()
  if (lowered.includes('photo')) return 'photo-triage'
  if (lowered.includes('document')) return 'document-intake'
  if (lowered.includes('approval')) return 'approval-desk'
  if (lowered.includes('operations')) return 'operations-desk'
  return 'generic'
}

export interface RecipeSeed {
  key: string
  detail: FactDetail
}

export interface RecipeDefinition {
  id: RecipeId
  name: string
  description: string
  /** Baseline facts for a fresh session (op add, source 'recipe'). */
  seeds: RecipeSeed[]
}

function seed(key: string, detail: FactDetail = {}): RecipeSeed {
  return { key, detail: { meta: { source: 'recipe' }, ...detail } }
}

export const RECIPES: Record<RecipeId, RecipeDefinition> = {
  // The flagship composition (docs/modules.md): chat + keyed photo slot +
  // follow-up card → legibility (decision) → archetype → follow-up →
  // price-band judges → verdict, quote, thread, escalation panels.
  'photo-triage': {
    id: 'photo-triage',
    name: 'Photo triage',
    description: 'Photos in, triage out, human escalation.',
    seeds: [
      seed('intake.photo'),
      seed('intake.chat'),
      seed('intake.follow_up'),
      seed('judge.decision', { meta: { source: 'recipe', decision_set: 'quote_or_visit' } }),
      seed('judge.archetype'),
      seed('judge.follow_up'),
      seed('judge.price_band'),
      seed('judge.escalation'),
      seed('judge.quality'),
      seed('dashboard.triage_verdict'),
      seed('dashboard.quote'),
      seed('dashboard.thread'),
      seed('dashboard.escalation'),
    ],
  },
  'document-intake': {
    id: 'document-intake',
    name: 'Document intake review',
    description: 'Claims and compliance packs, reviewed on arrival.',
    seeds: [
      seed('intake.files'),
      seed('intake.form'),
      seed('judge.decision', { meta: { source: 'recipe', decision_set: 'complete_incomplete' } }),
      seed('judge.quality'),
      seed('dashboard.summary'),
      seed('dashboard.metrics'),
      seed('dashboard.escalation'),
    ],
  },
  'approval-desk': {
    id: 'approval-desk',
    name: 'Approval desk',
    description: 'Applications judged for eligibility and risk.',
    seeds: [
      seed('intake.form'),
      seed('intake.request_kind'),
      seed('judge.decision', { meta: { source: 'recipe', decision_set: 'approve_reject' } }),
      seed('judge.escalation'),
      seed('dashboard.summary'),
      seed('dashboard.metrics'),
      seed('dashboard.escalation'),
    ],
  },
  'operations-desk': {
    id: 'operations-desk',
    name: 'Operations desk',
    description: 'Tickets and orders on one queue, two buttons.',
    seeds: [
      seed('intake.chat'),
      seed('intake.form'),
      seed('judge.decision', { meta: { source: 'recipe', decision_set: 'route' } }),
      seed('judge.quality'),
      seed('judge.escalation'),
      seed('dashboard.queue'),
      seed('dashboard.alerts'),
      seed('dashboard.kpi'),
      seed('dashboard.pipeline'),
      seed('dashboard.escalation'),
    ],
  },
  generic: {
    id: 'generic',
    name: 'Something else',
    description: WORKFLOW_TITLES.generic.description,
    seeds: [],
  },
}

/** Seed facts as a full LedgerFact list (op add, deterministic timestamps). */
export function recipeSeedFacts(recipeId: RecipeId): LedgerFact[] {
  return RECIPES[recipeId].seeds.map((item) => ({
    key: item.key,
    op: 'add' as const,
    area: areaForKey(item.key) ?? 'intake',
    detail: item.detail,
    transcript_ref: 'seed',
    at: '1970-01-01T00:00:00.000Z',
  }))
}

/** Humanise a closed-set option id for display labels ('one_ask' → 'One ask'). */
export function humaniseOption(option: string): string {
  return option
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

/** Humanise a price-band option ('band_a' → 'Band A', 'needs_visit' → 'Needs a visit'). */
export function humaniseBand(option: string): string {
  if (option === 'needs_visit') return 'Needs a visit'
  return humaniseOption(option)
}
