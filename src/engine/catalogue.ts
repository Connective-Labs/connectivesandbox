// The catalogue — the closed vocabulary of the fact ledger and the compiled
// specs. Every legal fact key, option set, threshold, and default string
// lives here. Nothing outside this file can mint a structure the compilers
// emit, which is WHY the compiler cannot produce duplicates or invalid
// structure: keys are closed, elements are one-per-key by construction.
//
// Mirrors the module catalogue in docs/modules.md. Pure module.

import type { FactArea, FactDetail, LedgerFact } from './facts.ts'

// ---------------------------------------------------------------------------
// Decision sets (closed option sets for the decision judge)
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
}

/** Deterministic thresholds. 0.85 is the sanctioned legibility exception. */
export const THRESHOLDS_STANDARD = { auto: 0.9, review: 0.5 } as const
export const THRESHOLDS_QUALITY = { auto: 0.85, review: 0.5 } as const

// ---------------------------------------------------------------------------
// Fact key space — the ONLY keys the classifier may emit
// ---------------------------------------------------------------------------

/** The five intake classes (docs/modules.md). */
export const INTAKE_KEYS = [
  'intake.photo',
  'intake.chat',
  'intake.form',
  'intake.request_kind',
  'intake.notes',
] as const

/** The judge classes. */
export const JUDGE_KEYS = ['judge.decision', 'judge.escalation', 'judge.quality'] as const

/** Dashboard facts (log + usage panels are always-on and need no fact). */
export const DASHBOARD_KEYS = ['dashboard.summary', 'dashboard.metrics'] as const

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
  'intake.photo': 'photo/document evidence slot — the client must submit images or files',
  'intake.chat': 'conversational free-form intake — the end user describes the job in their own words',
  'intake.form': 'structured multi-field record at intake (dates, reference numbers, quantities)',
  'intake.request_kind': 'one-tap closed choice for the end user (request kind, category)',
  'intake.notes': 'short typed note from the end user',
  'judge.decision': 'the closed-set decision judge (quote or visit, approve or reject, complete or incomplete)',
  'judge.escalation': 'a yes/no judge for when a human must look before anything happens',
  'judge.quality': 'a 0–1 legibility/completeness score judge for submissions that may be blurry or incomplete',
  'dashboard.summary': 'a narrative summary panel on the dashboard',
  'dashboard.metrics': 'an ops metrics tile on the dashboard',
}

// ---------------------------------------------------------------------------
// Default strings per key — catalogue fallbacks; GLM fills these slots once
// per newly created element and the strings cache on the fact thereafter.
// ---------------------------------------------------------------------------

export const DEFAULT_STRINGS: Record<string, Record<string, string>> = {
  'intake.photo': {
    label: 'Photos of the item',
    instructions: 'Upload clear photos of the affected area — sharp, well-lit, whole item in frame.',
  },
  'intake.chat': {
    placeholder: 'Describe what you need…',
    opening_message: 'Tell us about the job and attach photos where helpful.',
  },
  'intake.form': {
    question: 'Describe the job in your own words',
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
  'dashboard.summary': {
    title: 'Summary',
  },
  'dashboard.metrics': {
    title: 'Operations',
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

export type RecipeId = 'photo-triage' | 'document-intake' | 'approval-desk' | 'generic'

/** 'operations-desk' is an accepted alias of approval-desk (brief wording). */
export function normaliseRecipeId(recipeId: string | null | undefined): RecipeId {
  if (recipeId === 'photo-triage' || recipeId === 'document-intake' || recipeId === 'approval-desk') {
    return recipeId
  }
  if (recipeId === 'operations-desk') return 'approval-desk'
  return 'generic'
}

/** Match a workflow name (RecipePicker names) to a recipe. */
export function recipeFromName(name: string): RecipeId {
  const lowered = name.toLowerCase()
  if (lowered.includes('photo')) return 'photo-triage'
  if (lowered.includes('document')) return 'document-intake'
  if (lowered.includes('approval') || lowered.includes('operations')) return 'approval-desk'
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

export const RECIPES: Record<Exclude<RecipeId, 'generic'>, RecipeDefinition> & Record<'generic', RecipeDefinition> = {
  'photo-triage': {
    id: 'photo-triage',
    name: 'Photo triage',
    description: 'Photos in, triage out, human escalation.',
    seeds: [
      seed('intake.photo'),
      seed('judge.decision', { meta: { source: 'recipe', decision_set: 'quote_or_visit' } }),
      seed('judge.escalation'),
      seed('judge.quality'),
      seed('dashboard.summary'),
      seed('dashboard.metrics'),
    ],
  },
  'document-intake': {
    id: 'document-intake',
    name: 'Document intake review',
    description: 'Claims and compliance packs, reviewed on arrival.',
    seeds: [
      seed('intake.photo'),
      seed('intake.form'),
      seed('judge.decision', { meta: { source: 'recipe', decision_set: 'complete_incomplete' } }),
      seed('judge.quality'),
      seed('dashboard.summary'),
      seed('dashboard.metrics'),
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
