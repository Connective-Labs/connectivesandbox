// live-facts — the fact-ledger brain (livebuild v2).
//
// CAPTAIN DECISIONS (live testing, supersede the single-call draft design):
//   1. TWO-STAGE JEV, NO LLM EXCEPT STRINGS.
//      Stage 1: jev reads the rolling transcript every ~5 seconds and judges
//      ONLY whether a material change happened.
//      Stage 2: only on material change, a SECOND jev call extracts the
//      structured keyed facts. Compilers (src/engine/compilers.ts) build the
//      spec. GLM is used ONLY for strings on newly created elements — never
//      in screening, extraction, or structure.
//   2. A DRAFT IS NEVER REJECTED. The compiler guarantees Zod validity by
//      construction (deterministic placeholders); on a bug-level failure the
//      recipe baseline compiles instead. A rejected draft is a pipeline bug,
//      not a user-visible error.
//   3. Idempotency by key: repetition in speech appends rows but replays to
//      ONE active fact per key — duplicates are impossible by construction.
//
//   POST   /live-facts  { client_id, workflow_id?, session_id, recipe_id?,
//                         new_segments?, rolling_tail?, transcript_digest?,
//                         compile_signature? }
//   GET    /live-facts?client_id=&session_id=   replayed ledger state (admin)
//
// POST pipeline:
//   1. persist final transcript segments (service_role; never client-visible)
//   2. flush mode (no segments + compile_signature): skip jev, compile the
//      current ledger if it drifted from the last drafted signature — the
//      draft cooldown floor (~10s) holds without losing the final state
//   3. screen cooldown (~5s, durable anchor: transcript_segments) →
//      STAGE 1 jev: material_change | no_change over the rolling transcript
//   4. no material change → cheap return (the common case)
//   5. extract cooldown (~8s, durable anchor: transcript_facts) →
//      STAGE 2 jev: keyed fact ops (add | update | confirm | remove) over the
//      closed catalogue key space, the decision set, and the option facts
//   6. fold classified ops against the replayed ledger — semantic idempotency:
//      add-on-active demotes to confirm, remove-on-inactive is dropped,
//      confirm-on-inactive promotes to add
//   7. GLM string pass for NEWLY created elements only (one call, silent
//      failure — catalogue placeholders keep validity)
//   8. append fact rows; if the ledger signature changed and the draft
//      cooldown passed: compile → validate → new spec_drafts version
//   9. respond with the appended ops, the replayed ledger, the signature, and
//      the draft (if any)
//
// No audio ever reaches this function — text segments only. No secret ever
// leaves the server. Judges never return free text into the UI.

import { handleOptions, jsonResponse } from '../_shared/cors.ts'
import { readSession } from '../_shared/jwt.ts'
import { restInsert, restSelect } from '../_shared/rest.ts'
import { glmChat } from '../_shared/glm.ts'

import { safeParseWorkflowSpec } from '../../../src/engine/schema.ts'
import { compileSpec } from '../../../src/engine/compilers.ts'
import {
  applyFacts,
  ledgerSignature,
  type FactArea,
  type FactDetail,
  type FactLedgerState,
  type FactOp,
  type FactStrings,
  type LedgerFact,
} from '../../../src/engine/facts.ts'
import {
  areaForKey,
  DEFAULT_STRINGS,
  DECISION_SETS,
  FACT_OP_OPTIONS,
  factKeyMatches,
  KEY_RUBRICS,
  normaliseRecipeId,
  recipeFromName,
  type RecipeId,
} from '../../../src/engine/catalogue.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SEGMENTS_PER_CALL = 40
const MAX_TAIL_CHARS = 600
const MAX_DIGEST_CHARS = 4000

function envNumber(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const SCREEN_COOLDOWN_SECONDS = envNumber('SCREEN_COOLDOWN_SECONDS', 5)
const EXTRACT_COOLDOWN_SECONDS = envNumber('EXTRACT_COOLDOWN_SECONDS', 8)
const DRAFT_COOLDOWN_SECONDS = envNumber('DRAFT_COOLDOWN_SECONDS', 10)
const MAX_FACTS_PER_SESSION = envNumber('MAX_FACTS_PER_SESSION', 300)

// ---------------------------------------------------------------------------
// Wire helpers (openjev contract — see src/services/judge/jev.ts)
// ---------------------------------------------------------------------------

interface WireQuestion {
  type: 'choice'
  criteria: Record<string, string>
}

interface WireResponse {
  answers?: Record<string, { type?: string; choice?: string; confidence?: number } | undefined>
}

function parseChoice(raw: { choice?: string } | undefined, legal: readonly string[], fallback: string): string {
  const choice = raw?.choice?.toLowerCase() ?? ''
  return legal.includes(choice) ? choice : fallback
}

async function jevCall(
  state: string,
  questions: Record<string, WireQuestion>,
): Promise<{ answers: Record<string, { choice?: string; confidence?: number } | undefined> } | { error: string }> {
  const endpoint = Deno.env.get('JUDGE_ENDPOINT_URL')
  const apiKey = Deno.env.get('JUDGE_API_KEY')
  if (!endpoint || !apiKey) return { error: 'Judge screening is not configured' }
  const model = Deno.env.get('JUDGE_MODEL') ?? 'openjev-latest'
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, state, questions }),
    })
  } catch (error) {
    return { error: `Judge transport failed: ${(error as Error).message}` }
  }
  const raw = await response.text()
  if (!response.ok) return { error: `Judge endpoint returned ${response.status}: ${raw.slice(0, 300)}` }
  try {
    const parsed = JSON.parse(raw) as WireResponse
    return { answers: parsed.answers ?? {} }
  } catch {
    return { error: 'Judge response was not valid JSON' }
  }
}

// ---------------------------------------------------------------------------
// Ledger IO — durable, replayed deterministically in (created_at, id) order
// ---------------------------------------------------------------------------

interface FactRow {
  key: string
  op: string
  area: string
  detail: FactDetail
  transcript_ref: string | null
  created_at: string
}

function rowToFact(row: FactRow): LedgerFact | null {
  if (typeof row.key !== 'string' || !factKeyMatches(row.key)) return null
  const op = row.op as FactOp
  if (!['add', 'update', 'confirm', 'remove'].includes(op)) return null
  const area = (areaForKey(row.key) ?? (['intake', 'judges', 'dashboard'].includes(row.area) ? row.area : 'intake')) as FactArea
  return {
    key: row.key,
    op,
    area,
    detail: typeof row.detail === 'object' && row.detail !== null ? row.detail : {},
    transcript_ref: row.transcript_ref,
    at: row.created_at,
  }
}

async function loadLedgerFacts(clientId: string, sessionId: string): Promise<LedgerFact[]> {
  const rows = await restSelect<FactRow>('transcript_facts', {
    client_id: `eq.${clientId}`,
    session_id: `eq.${sessionId}`,
    select: 'key,op,area,detail,transcript_ref,created_at',
    order: 'created_at.asc,id.asc',
  })
  return rows.map(rowToFact).filter((fact): fact is LedgerFact => fact !== null)
}

/** Human-readable one-line view of an active entry, for jev state. */
function ledgerDigest(state: FactLedgerState): string {
  const lines: string[] = []
  for (const entry of [...state.values()].filter((entry) => entry.active).sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const bits: string[] = []
    const decisionSet = entry.detail.meta?.decision_set
    if (typeof decisionSet === 'string') bits.push(`decision set ${decisionSet}`)
    const strings = entry.detail.strings ?? {}
    for (const value of Object.values(strings)) {
      if (typeof value === 'string' && value.trim().length > 0) bits.push(`“${value.trim()}”`)
    }
    lines.push(`- ${entry.key}${bits.length > 0 ? `: ${bits.join(', ')}` : ''}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(empty — nothing captured yet)'
}

function optionEntryActive(state: FactLedgerState, option: string): boolean {
  const entry = state.get(`judge.decision.options.${option}`)
  return entry === undefined ? true : entry.active
}

function currentDecisionSet(state: FactLedgerState, recipeId: RecipeId): string {
  const meta = state.get('judge.decision')?.detail.meta?.decision_set
  if (typeof meta === 'string' && meta in DECISION_SETS) return meta
  const seed = recipeId === 'generic' ? null : recipeSeedDecisionSet(recipeId)
  return seed ?? 'quote_or_visit'
}

function recipeSeedDecisionSet(recipeId: RecipeId): string | null {
  const seeds: Record<string, string> = {
    'photo-triage': 'quote_or_visit',
    'document-intake': 'complete_incomplete',
    'approval-desk': 'approve_reject',
  }
  return seeds[recipeId] ?? null
}

// ---------------------------------------------------------------------------
// STAGE 1 — material screen (rolling transcript, every ~5s)
// ---------------------------------------------------------------------------

function screenState(input: {
  transcriptDigest?: string
  rollingTail?: string
  segments: string[]
  ledger: string
}): string {
  return [
    'You are the discovery-call screener for Connective Sandbox. ' +
      'The state is a rolling digest of a sales call between a rep and their client, the newest ' +
      'transcribed words, and the workflow facts captured so far. Answer the question.',
    'RUBRIC FIELDS: decision type, intake shape, judge set, escalation path, dashboard needs.',
    `FACTS CAPTURED SO FAR:\n${input.ledger}`,
    `ROLLING TRANSCRIPT (oldest → newest):\n${(input.transcriptDigest ?? '').slice(-MAX_DIGEST_CHARS)}`,
    input.segments.length > 0 ? `NEWEST SENTENCES:\n${input.segments.map((text) => `- ${text}`).join('\n')}` : '',
    input.rollingTail ? `STILL BEING SPOKEN (may be incomplete): ${input.rollingTail}` : '',
    'QUESTION CRITERIA:',
    `materiality: ${JSON.stringify({
      material_change: 'The segments introduce or alter decision type, intake shape, judge set, or escalation path.',
      minor_change: 'A refinement that does not alter structure but could improve wording or details.',
      no_change: 'Small talk, pleasantries, filler, or nothing material.',
    })}`,
  ].filter((part) => part.length > 0).join('\n\n')
}

async function screenMateriality(input: {
  transcriptDigest?: string
  rollingTail?: string
  segments: string[]
  ledger: string
}): Promise<{ material: boolean; confidence: number } | { error: string }> {
  const result = await jevCall(screenState(input), {
    materiality: {
      type: 'choice',
      criteria: {
        material_change: 'Introduces or alters decision type, intake shape, judge set, or escalation path.',
        minor_change: 'A refinement that does not alter structure but could improve wording or details.',
        no_change: 'Small talk, pleasantries, filler, or nothing material.',
      },
    },
  })
  if ('error' in result) return result
  const choice = parseChoice(
    result.answers.materiality,
    ['material_change', 'minor_change', 'no_change'],
    'no_change',
  )
  const confidence = result.answers.materiality?.confidence
  return {
    material: choice === 'material_change',
    confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
  }
}

// ---------------------------------------------------------------------------
// STAGE 2 — keyed fact extraction (only on material change)
// ---------------------------------------------------------------------------

const FACT_KEYS: readonly string[] = [
  'intake.photo',
  'intake.chat',
  'intake.form',
  'intake.request_kind',
  'intake.notes',
  'judge.decision',
  'judge.escalation',
  'judge.quality',
  'dashboard.summary',
  'dashboard.metrics',
]

function opCriteria(key: string): Record<string, string> {
  return {
    add: `The transcript indicates ${KEY_RUBRICS[key] ?? key} is needed and it is NOT already captured in FACTS CAPTURED SO FAR.`,
    update: `Already captured, but the newest words add materially richer detail about it.`,
    confirm: `Already captured, and the newest words simply restate it.`,
    remove: `The transcript explicitly rules it out.`,
    no_change: `The newest words say nothing about it.`,
  }
}

function extractState(input: {
  transcriptDigest?: string
  rollingTail?: string
  segments: string[]
  ledger: string
  decisionSet: string
  decisionOptions: string[]
}): string {
  const opLines = FACT_KEYS.map((key) => `- ${key}: ${JSON.stringify(opCriteria(key))}`)
  return [
    'You extract STRUCTURED FACTS from a live workflow-building discovery call. ' +
      'The workflow is a compiled projection of a keyed fact ledger; your facts are appended to it. ' +
      'Keys are a CLOSED vocabulary — you may only answer with the operations offered. ' +
      'Restatements are confirm, never duplicate adds.',
    `FACTS CAPTURED SO FAR:\n${input.ledger}`,
    `The decision judge currently uses the closed "${input.decisionSet}" set with options ${JSON.stringify(input.decisionOptions)}.`,
    `ROLLING TRANSCRIPT (oldest → newest):\n${(input.transcriptDigest ?? '').slice(-MAX_DIGEST_CHARS)}`,
    input.segments.length > 0 ? `NEWEST SENTENCES:\n${input.segments.map((text) => `- ${text}`).join('\n')}` : '',
    input.rollingTail ? `STILL BEING SPOKEN (may be incomplete): ${input.rollingTail}` : '',
    'OPERATION CRITERIA per fact key:',
    opLines.join('\n'),
    `decision_set: choose the closed decision set that fits the transcript, or keep_current.`,
    `For each option of the current decision set (${input.decisionOptions.join(', ')}): keep if still wanted, remove if explicitly ruled out, add if it was removed before but is wanted again.`,
  ].filter((part) => part.length > 0).join('\n\n')
}

interface ExtractedFacts {
  keyOps: { key: string; op: FactOp }[]
  decisionSet: string | null
  optionOps: { option: string; op: FactOp }[]
}

async function extractFacts(input: {
  transcriptDigest?: string
  rollingTail?: string
  segments: string[]
  ledger: string
  decisionSet: string
  decisionOptions: string[]
}): Promise<ExtractedFacts | { error: string }> {
  const questions: Record<string, WireQuestion> = {}
  for (const key of FACT_KEYS) {
    questions[key] = { type: 'choice', criteria: opCriteria(key) }
  }
  questions.decision_set = {
    type: 'choice',
    criteria: Object.fromEntries([
      ...Object.entries(DECISION_SETS).map(([key, set]) => [
        key,
        `Decision set {${set.options.join(', ')}} (worst case "${set.worst}" → human review).`,
      ]),
      ['keep_current', `Keep the current "${input.decisionSet}" set.`],
    ]),
  }
  for (const option of input.decisionOptions) {
    questions[`opt_${option}`] = {
      type: 'choice',
      criteria: {
        keep: `The "${option}" disposition is still wanted.`,
        remove: `The transcript explicitly rules "${option}" out.`,
        add: `"${option}" was removed before but is wanted again.`,
      },
    }
  }

  const result = await jevCall(extractState(input), questions)
  if ('error' in result) return result
  const answers = result.answers

  const keyOps: { key: string; op: FactOp }[] = []
  for (const key of FACT_KEYS) {
    const op = parseChoice(answers[key], FACT_OP_OPTIONS, 'no_change')
    if (op !== 'no_change') keyOps.push({ key, op: op as FactOp })
  }
  const decisionSetChoice = parseChoice(
    answers.decision_set,
    [...Object.keys(DECISION_SETS), 'keep_current'],
    'keep_current',
  )
  const optionOps: { option: string; op: FactOp }[] = []
  for (const option of input.decisionOptions) {
    const choice = parseChoice(answers[`opt_${option}`], ['keep', 'remove', 'add'], 'keep')
    if (choice !== 'keep') optionOps.push({ option, op: choice as FactOp })
  }
  return {
    keyOps,
    decisionSet: decisionSetChoice === 'keep_current' ? null : decisionSetChoice,
    optionOps,
  }
}

// ---------------------------------------------------------------------------
// Folding — semantic idempotency against the replayed ledger
// ---------------------------------------------------------------------------

interface AppendPlan {
  key: string
  op: FactOp
  area: FactArea
  detail: FactDetail
}

function foldExtracted(
  stateBefore: FactLedgerState,
  extracted: ExtractedFacts,
  recipeId: RecipeId,
): AppendPlan[] {
  const plans: AppendPlan[] = []
  const isActive = (key: string) => stateBefore.get(key)?.active ?? false

  for (const { key, op } of extracted.keyOps) {
    if (!factKeyMatches(key)) continue
    const area = areaForKey(key)
    if (area === null) continue
    let factOp: FactOp | null = op
    if (op === 'add' && isActive(key)) factOp = 'confirm' // repetition is harmless
    if (op === 'remove' && !isActive(key)) factOp = null // already out; no tombstone spam
    if ((op === 'confirm' || op === 'update') && !isActive(key)) factOp = 'add' // re-activation intent
    if (factOp === null) continue
    plans.push({ key, op: factOp, area, detail: {} })
  }

  // Decision set: attach to the judge.decision fact when one is appended,
  // otherwise synthesise an update when the set actually changes.
  if (extracted.decisionSet !== null) {
    const current = currentDecisionSet(stateBefore, recipeId)
    if (extracted.decisionSet !== current) {
      const plan = plans.find((entry) => entry.key === 'judge.decision')
      if (plan !== undefined && plan.op !== 'remove') {
        plan.detail = { ...plan.detail, meta: { ...plan.detail.meta, decision_set: extracted.decisionSet } }
      } else if (plan === undefined) {
        plans.push({
          key: 'judge.decision',
          op: 'update',
          area: 'judges',
          detail: { meta: { decision_set: extracted.decisionSet } },
        })
      }
    }
  }

  // Option facts — only within the decision set in force at fold time.
  const decisionSet = extracted.decisionSet ?? currentDecisionSet(stateBefore, 'generic')
  const legalOptions = new Set(DECISION_SETS[decisionSet]?.options ?? [])
  for (const { option, op } of extracted.optionOps) {
    if (!legalOptions.has(option)) continue
    const key = `judge.decision.options.${option}`
    if (op === 'remove' && optionEntryActive(stateBefore, option)) {
      plans.push({ key, op: 'remove', area: 'judges', detail: {} })
    } else if (op === 'add' && !optionEntryActive(stateBefore, option)) {
      plans.push({ key, op: 'add', area: 'judges', detail: {} })
    }
    // keep / already-in-state: nothing to append.
  }
  return plans
}

// ---------------------------------------------------------------------------
// GLM string pass — NEWLY created elements only; silent failure is fine.
// ---------------------------------------------------------------------------

function extractJsonMap(content: string): Record<string, unknown> | null {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  const candidates = [
    ...fenced.map((match) => match[1]?.trim()).filter((value): value is string => value !== undefined),
    content,
  ]
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

const SLOT_LIMITS: Record<string, number> = { question: 200 }
const DEFAULT_SLOT_LIMIT = 160

/**
 * Fill string slots for the given keys (newly created elements and quiet
 * retries on missing slots). One GLM call; any failure leaves catalogue
 * placeholders in place — validity never depends on GLM.
 */
async function fillStrings(
  plans: AppendPlan[],
  stateBefore: FactLedgerState,
  transcriptTail: string[],
): Promise<void> {
  const wanted = plans.filter((plan) => plan.op !== 'remove' && DEFAULT_STRINGS[plan.key] !== undefined)
  if (wanted.length === 0) return
  const slots: { plan: AppendPlan; slot: string; fallback: string; path: string }[] = []
  for (const plan of wanted) {
    for (const [slot, fallback] of Object.entries(DEFAULT_STRINGS[plan.key])) {
      const existing = stateBefore.get(plan.key)?.detail.strings?.[slot as keyof FactStrings]
      if (typeof existing === 'string' && existing.trim().length > 0) continue // never rewrite cached copy
      slots.push({ plan, slot, fallback, path: `${plan.key}::${slot}` })
    }
  }
  if (slots.length === 0) return

  const offered = slots.map((entry) => `"${entry.path}": "${entry.fallback.replace(/"/g, '\\"')}"`).join(',\n')
  const messages = [
    {
      role: 'system' as const,
      content: 'You fill string slots for newly created workflow elements. Output one JSON object only.',
    },
    {
      role: 'user' as const,
      content: [
        'A workflow is being compiled from a fact ledger; the STRUCTURE is final and not yours to change. ' +
          'Fill ONLY the string slots below with short, plain, brand-consistent copy (Singapore English). ' +
          'Reply with ONE JSON object mapping slot path → string and NOTHING else.',
        `WHAT THE CLIENT SAID (newest last):\n${transcriptTail.join('\n').slice(-2000)}`,
        `SLOTS (path: current placeholder):\n${offered}`,
      ].join('\n\n'),
    },
  ]
  try {
    const content = await glmChat(messages, { maxTokens: 2048, reasoningEffort: 'low' })
    const map = extractJsonMap(content)
    if (map === null) return
    for (const entry of slots) {
      const value = map[entry.path]
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      const limit = SLOT_LIMITS[entry.slot] ?? DEFAULT_SLOT_LIMIT
      if (trimmed.length === 0 || trimmed.length > limit) continue // silent failure: keep placeholder
      entry.plan.detail = {
        ...entry.plan.detail,
        strings: { ...entry.plan.detail.strings, [entry.slot]: trimmed },
      }
    }
  } catch (error) {
    console.log(`[live-facts] GLM string pass skipped: ${(error as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Compilation — a draft is NEVER rejected (captain decision)
// ---------------------------------------------------------------------------

function compileDraft(recipeId: RecipeId, state: FactLedgerState): { spec: ReturnType<typeof compileSpec>; baseline: boolean } {
  const compiled = compileSpec(recipeId, state)
  const parsed = safeParseWorkflowSpec(compiled)
  if (parsed.success) return { spec: parsed.data, baseline: false }
  // Bug-level failure (the compiler is valid by construction and tested):
  // fall back to the recipe baseline, which is proven valid. Log loudly.
  console.log(`[live-facts] COMPILED SPEC INVALID — pipeline bug: ${parsed.error.issues[0]?.message}`)
  const baseline = compileSpec(recipeId, new Map())
  const baselineParsed = safeParseWorkflowSpec(baseline)
  if (baselineParsed.success) return { spec: baselineParsed.data, baseline: true }
  throw new Error('recipe baseline failed validation — catalogue broken')
}

function deltaSummary(plans: AppendPlan[]): string {
  const labels: Record<string, string> = {
    'intake.photo': 'photo slot',
    'intake.chat': 'free-text intake',
    'intake.form': 'details form',
    'intake.request_kind': 'request-kind picker',
    'intake.notes': 'short note field',
    'judge.decision': 'decision judge',
    'judge.escalation': 'escalation judge',
    'judge.quality': 'quality judge',
    'dashboard.summary': 'summary panel',
    'dashboard.metrics': 'ops metrics',
  }
  const parts: string[] = []
  for (const plan of plans) {
    const noun = labels[plan.key] ?? (plan.key.startsWith('judge.decision.options.') ? `${plan.key.split('.').pop()} option` : plan.key)
    const verb = plan.op === 'add' ? 'added' : plan.op === 'remove' ? 'removed' : plan.op === 'update' ? 'updated' : 'confirmed'
    parts.push(`${noun} ${verb}`)
  }
  return parts.length > 0 ? parts.slice(0, 4).join(' · ') : 'facts confirmed'
}

// ---------------------------------------------------------------------------
// Durable cooldowns — anchors survive isolate recycling
// ---------------------------------------------------------------------------

async function lastScreenAt(clientId: string, sessionId: string): Promise<number> {
  const rows = await restSelect<{ created_at: string }>('transcript_segments', {
    client_id: `eq.${clientId}`,
    session_id: `eq.${sessionId}`,
    select: 'created_at',
    order: 'created_at.desc',
    limit: '1',
  })
  return rows.length > 0 ? Date.parse(rows[0].created_at) : 0
}

async function lastFactAt(clientId: string, sessionId: string): Promise<number> {
  const rows = await restSelect<{ created_at: string }>('transcript_facts', {
    client_id: `eq.${clientId}`,
    session_id: `eq.${sessionId}`,
    select: 'created_at',
    order: 'created_at.desc',
    limit: '1',
  })
  return rows.length > 0 ? Date.parse(rows[0].created_at) : 0
}

async function draftCooldownActive(clientId: string, sessionId: string): Promise<boolean> {
  const rows = await restSelect<{ created_at: string }>('spec_drafts', {
    client_id: `eq.${clientId}`,
    session_id: `eq.${sessionId}`,
    select: 'created_at',
    order: 'created_at.desc',
    limit: '1',
  })
  if (rows.length === 0) return false
  const last = Date.parse(rows[0].created_at)
  return Number.isNaN(last) ? false : Date.now() - last < DRAFT_COOLDOWN_SECONDS * 1000
}

async function nextDraftVersion(clientId: string, workflowId: string | null, sessionId: string): Promise<number> {
  const params: Record<string, string> = {
    client_id: `eq.${clientId}`,
    select: 'version',
    order: 'version.desc',
    limit: '1',
  }
  if (workflowId !== null) params.workflow_id = `eq.${workflowId}`
  else params.session_id = `eq.${sessionId}`
  const rows = await restSelect<{ version: number }>('spec_drafts', params)
  return (rows[0]?.version ?? 0) + 1
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface SegmentInput {
  segment_index?: number
  text?: string
}

interface LiveFactsBody {
  client_id?: string
  workflow_id?: string | null
  session_id?: string
  recipe_id?: string
  new_segments?: SegmentInput[]
  rolling_tail?: string
  transcript_digest?: string
  compile_signature?: string
}

function segmentTexts(segments: SegmentInput[] | undefined): string[] {
  return (segments ?? [])
    .map((segment) => (typeof segment?.text === 'string' ? segment.text.trim() : ''))
    .filter((text) => text.length > 0)
    .slice(0, MAX_SEGMENTS_PER_CALL)
}

function ledgerView(state: FactLedgerState): Record<string, unknown>[] {
  return [...state.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => ({
      key: entry.key,
      op: entry.lastOp,
      area: entry.area,
      active: entry.active,
      detail: entry.detail,
      ops: entry.ops,
    }))
}

async function maybeDraft(input: {
  clientId: string
  workflowId: string | null
  sessionId: string
  recipeId: RecipeId
  state: FactLedgerState
  changed: boolean
  summary: string
}): Promise<{ draft: Record<string, unknown> | null; suppressed: boolean; baseline: boolean }> {
  if (!input.changed) return { draft: null, suppressed: false, baseline: false }
  if (await draftCooldownActive(input.clientId, input.sessionId)) {
    return { draft: null, suppressed: true, baseline: false }
  }
  const compiled = compileDraft(input.recipeId, input.state)
  const version = await nextDraftVersion(input.clientId, input.workflowId, input.sessionId)
  const inserted = await restInsert<{ id: string; version: number }>('spec_drafts', {
    client_id: input.clientId,
    session_id: input.sessionId,
    ...(input.workflowId !== null ? { workflow_id: input.workflowId } : {}),
    version,
    spec: compiled.spec,
    delta_summary: input.summary,
    source: 'transcript',
    published: false,
  })
  return {
    draft: {
      id: inserted[0]?.id ?? null,
      version: inserted[0]?.version ?? version,
      spec: compiled.spec,
      delta_summary: input.summary,
    },
    suppressed: false,
    baseline: compiled.baseline,
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return handleOptions(request)

  const session = await readSession(request)
  if (!session) return jsonResponse(request, { error: 'Not authenticated' }, 401)
  if (session.app_role !== 'admin') return jsonResponse(request, { error: 'Admin session required' }, 403)

  try {
    const url = new URL(request.url)

    // ---------------------------------------------------------------
    // GET — replayed ledger state for a session (admin reload). The recipe
    // context MUST match the POST path (explicit recipe_id, else inferred
    // from the workflow name) so signatures are comparable across calls.
    // ---------------------------------------------------------------
    if (request.method === 'GET') {
      const clientId = url.searchParams.get('client_id') ?? ''
      const sessionId = url.searchParams.get('session_id') ?? ''
      if (!UUID_RE.test(clientId) || sessionId.length === 0) {
        return jsonResponse(request, { error: 'client_id and session_id are required' }, 400)
      }
      let recipeId = normaliseRecipeId(url.searchParams.get('recipe_id'))
      const workflowIdParam = url.searchParams.get('workflow_id')
      if (recipeId === 'generic' && workflowIdParam !== null && UUID_RE.test(workflowIdParam)) {
        const rows = await restSelect<{ name: string }>('workflows', {
          id: `eq.${workflowIdParam}`,
          select: 'name',
          limit: '1',
        })
        if (rows.length > 0) recipeId = recipeFromName(rows[0].name)
      }
      const facts = await loadLedgerFacts(clientId, sessionId)
      const state = applyFacts(facts)
      return jsonResponse(request, {
        ledger: ledgerView(state),
        signature: ledgerSignature(state, recipeId),
        structural_signature: ledgerSignature(state, recipeId, { strings: false }),
        fact_count: facts.length,
      })
    }

    if (request.method !== 'POST') {
      return jsonResponse(request, { error: 'Unsupported method' }, 405)
    }

    const body = (await request.json()) as LiveFactsBody
    const clientId = typeof body.client_id === 'string' ? body.client_id : ''
    const sessionId = typeof body.session_id === 'string' ? body.session_id.slice(0, 120) : ''
    const workflowId = typeof body.workflow_id === 'string' && UUID_RE.test(body.workflow_id) ? body.workflow_id : null
    if (!UUID_RE.test(clientId) || sessionId.length === 0) {
      return jsonResponse(request, { error: 'client_id and session_id are required' }, 400)
    }

    // Recipe: explicit id wins, else infer from the workflow name, else generic.
    let recipeId = normaliseRecipeId(body.recipe_id)
    if (recipeId === 'generic' && workflowId !== null) {
      const rows = await restSelect<{ name: string }>('workflows', {
        id: `eq.${workflowId}`,
        select: 'name',
        limit: '1',
      })
      if (rows.length > 0) recipeId = recipeFromName(rows[0].name)
    }

    const segments = segmentTexts(body.new_segments)
    const rollingTail = typeof body.rolling_tail === 'string' ? body.rolling_tail.trim().slice(0, MAX_TAIL_CHARS) : ''
    const digest = typeof body.transcript_digest === 'string' ? body.transcript_digest : ''
    const transcriptRef = segments.length > 0 ? `seg:${body.new_segments?.[0]?.segment_index ?? 0}` : 'tail'

    // Load the durable ledger ONCE; everything below folds against it.
    const facts = await loadLedgerFacts(clientId, sessionId)
    const stateBefore = applyFacts(facts)

    // ---------------------------------------------------------------
    // Flush mode: no new words; compile the current ledger if it drifted
    // from the last drafted signature. No jev spend, draft floor holds.
    // ---------------------------------------------------------------
    if (segments.length === 0 && rollingTail.length === 0 && typeof body.compile_signature === 'string') {
      const signature = ledgerSignature(stateBefore, recipeId)
      if (signature === body.compile_signature) {
        return jsonResponse(request, { changed: false, ledger: ledgerView(stateBefore), signature })
      }
      let flushDraft: Awaited<ReturnType<typeof maybeDraft>> = { draft: null, suppressed: false, baseline: false }
      try {
        flushDraft = await maybeDraft({
          clientId,
          workflowId,
          sessionId,
          recipeId,
          state: stateBefore,
          changed: true,
          summary: 'ledger settled',
        })
      } catch (error) {
        console.error('[live-facts] flush draft failed:', error instanceof Error ? error.message : error)
      }
      return jsonResponse(request, {
        changed: true,
        appended: [],
        ledger: ledgerView(stateBefore),
        signature,
        ...(flushDraft.draft !== null ? { draft: flushDraft.draft } : {}),
        ...(flushDraft.suppressed ? { draft_suppressed: true } : {}),
      })
    }

    if (segments.length === 0 && rollingTail.length === 0) {
      return jsonResponse(request, { error: 'new_segments or rolling_tail are required' }, 400)
    }

    // Screen cooldown anchor FIRST — the segments persisted below belong to
    // THIS request and must not advance the cadence window against itself.
    const lastScreen = await lastScreenAt(clientId, sessionId)

    // 1. Persist the final segments (durability; the rolling tail is ephemeral).
    if (segments.length > 0) {
      const indexed = body.new_segments?.every?.((segment) => typeof segment?.segment_index === 'number') ?? false
      await restInsert('transcript_segments', segments.map((text, index) => ({
        client_id: clientId,
        ...(workflowId !== null ? { workflow_id: workflowId } : {}),
        session_id: sessionId,
        segment_index: indexed ? body.new_segments?.[index]?.segment_index : index,
        text,
      })))
    }

    // 2. Screen cooldown (~5s cadence, durable anchor) — then STAGE 1.
    if (Date.now() - lastScreen < SCREEN_COOLDOWN_SECONDS * 1000) {
      return jsonResponse(request, {
        changed: false,
        screen_suppressed: true,
        ledger: ledgerView(stateBefore),
        signature: ledgerSignature(stateBefore, recipeId),
      })
    }

    const ledger = ledgerDigest(stateBefore)
    const screening = await screenMateriality({
      transcriptDigest: digest,
      rollingTail,
      segments,
      ledger,
    })
    if ('error' in screening) {
      return jsonResponse(request, { changed: false, error: screening.error }, 502)
    }
    if (!screening.material) {
      return jsonResponse(request, {
        changed: false,
        screen: 'no_change',
        screen_confidence: screening.confidence,
        ledger: ledgerView(stateBefore),
        signature: ledgerSignature(stateBefore, recipeId),
      })
    }

    // 3. Extract cooldown (~8s) — bounds stage-2 spend per session.
    const lastFact = await lastFactAt(clientId, sessionId)
    if (facts.length >= MAX_FACTS_PER_SESSION || Date.now() - lastFact < EXTRACT_COOLDOWN_SECONDS * 1000) {
      return jsonResponse(request, {
        changed: true,
        facts_suppressed: true,
        screen: 'material_change',
        ledger: ledgerView(stateBefore),
        signature: ledgerSignature(stateBefore, recipeId),
      })
    }

    // 4. STAGE 2 — keyed fact extraction.
    const decisionSet = currentDecisionSet(stateBefore, recipeId)
    const extracted = await extractFacts({
      transcriptDigest: digest,
      rollingTail,
      segments,
      ledger,
      decisionSet,
      decisionOptions: DECISION_SETS[decisionSet]?.options ?? [],
    })
    if ('error' in extracted) {
      return jsonResponse(request, { changed: false, error: extracted.error }, 502)
    }

    // 5. Fold → semantic idempotency against the ledger.
    let plans = foldExtracted(stateBefore, extracted, recipeId)
    if (plans.length === 0) {
      return jsonResponse(request, {
        changed: false,
        screen: 'material_change',
        note: 'no new facts after idempotent fold',
        ledger: ledgerView(stateBefore),
        signature: ledgerSignature(stateBefore, recipeId),
      })
    }

    // 6. GLM strings for newly created elements only (silent failure OK).
    await fillStrings(plans, stateBefore, [...segments, rollingTail].filter((text) => text.length > 0))

    // 7. Append durable rows (cap enforced).
    const room = Math.max(0, MAX_FACTS_PER_SESSION - facts.length)
    const capped = plans.length > room
    plans = plans.slice(0, room)
    if (plans.length > 0) {
      await restInsert('transcript_facts', plans.map((plan) => ({
        client_id: clientId,
        ...(workflowId !== null ? { workflow_id: workflowId } : {}),
        session_id: sessionId,
        key: plan.key,
        op: plan.op,
        area: plan.area,
        detail: plan.detail,
        transcript_ref: transcriptRef,
      })))
    }

    // 8. Replay with the appended facts; compile if the ledger moved.
    const stateAfter = applyFacts([...facts, ...plans.map((plan) => ({
      key: plan.key,
      op: plan.op,
      area: plan.area,
      detail: plan.detail,
      transcript_ref: transcriptRef,
      at: new Date().toISOString(),
    }))])
    const signature = ledgerSignature(stateAfter, recipeId)
    const changed = signature !== ledgerSignature(stateBefore, recipeId)

    let draftResult: Awaited<ReturnType<typeof maybeDraft>> = { draft: null, suppressed: false, baseline: false }
    if (changed) {
      try {
        draftResult = await maybeDraft({
          clientId,
          workflowId,
          sessionId,
          recipeId,
          state: stateAfter,
          changed: true,
          summary: deltaSummary(plans),
        })
      } catch (error) {
        console.error('[live-facts] draft failed:', error instanceof Error ? error.message : error)
      }
    }

    return jsonResponse(request, {
      changed,
      screen: 'material_change',
      appended: plans.map((plan) => ({ key: plan.key, op: plan.op, area: plan.area })),
      ledger: ledgerView(stateAfter),
      signature,
      ...(capped ? { fact_cap_reached: true } : {}),
      ...(draftResult.draft !== null ? { draft: draftResult.draft } : {}),
      ...(changed && draftResult.suppressed ? { draft_suppressed: true } : {}),
    })
  } catch (error) {
    console.error('[live-facts] error:', error instanceof Error ? error.message : error)
    return jsonResponse(request, { error: 'Internal error' }, 500)
  }
})
