// live-draft — the live transcription pipeline's screening + drafting brain.
//
// CAPTAIN DECISION (jev/GLM hybrid): openjev drives STRUCTURE, GLM-5.3-Flash
// fills STRINGS ONLY. GLM never adds, removes, reorders, or re-keys
// components, judges, or option sets — the spec skeleton is assembled from
// legal catalogue parts only, so the Zod validation below should pass by
// construction yet remains the hard gate.
//
//   POST   /live-draft   { client_id, workflow_id?, session_id, transcript_digest,
//                          new_segments: [{ segment_index?, text }], current_spec? }
//   GET    /live-draft?workflow_id=            list drafts for a workflow (admin only)
//   PATCH  /live-draft   { draft_id, published }   flip a draft's published flag
//   DELETE /live-draft?draft_id=               discard a draft
//
// POST pipeline (one invocation, one batched openjev classification call):
//   1. persist the transcript segments (service_role; nothing client-visible)
//   2. SCREEN + STRUCTURE — ONE batched openjev call (JUDGE_ENDPOINT_URL /
//      JUDGE_API_KEY): materiality (the change trigger) plus the structural
//      operations against the module catalogue, the named recipes, and the
//      discovery rubric (decision type, intake shape, judge set, escalation
//      path). Closed option sets and thresholds are deterministic catalogue
//      values — never GLM-authored.
//   3. no material change → return early; a rambling call screens cheaply.
//   4. rate guard: at most one draft per DRAFT_COOLDOWN_SECONDS (default 15)
//      per (client_id, session_id), enforced from spec_drafts so it survives
//      isolate recycling. A rambling call cannot churn drafts.
//   5. assemble the spec skeleton deterministically (stable parts of the
//      current spec kept; catalogue parts applied per the jev answers).
//   6. GLM fills STRING SLOTS ONLY (labels, capture hints, judge question
//      wording, narration). The slot map is a whitelist: anything else in the
//      GLM reply is ignored, so structure cannot be altered.
//   7. validate the assembled spec against the frozen Zod schema; on the
//      (near-impossible) failure, re-assemble with default strings once, then
//      surface the error — an invalid spec is NEVER returned.
// Judges never return free text into the UI; no audio ever reaches this
// function — text segments only.

import { handleOptions, jsonResponse } from '../_shared/cors.ts'
import { readSession } from '../_shared/jwt.ts'
import { restDelete, restInsert, restSelect, restUpdate } from '../_shared/rest.ts'
import { glmChat } from '../_shared/glm.ts'

import { safeParseWorkflowSpec } from '../../../src/engine/schema.ts'
import type { Judge, WorkflowSpec } from '../../../src/engine/types.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SEGMENTS_PER_CALL = 40
const SCREEN_OPTIONS = ['material_change', 'minor_change', 'no_change'] as const
type ScreenOption = (typeof SCREEN_OPTIONS)[number]
const COMPONENT_OP_OPTIONS = ['keep_existing', 'add', 'remove'] as const
type ComponentOp = (typeof COMPONENT_OP_OPTIONS)[number]

// ---------------------------------------------------------------------------
// Deterministic catalogue — legal parts only (docs/modules.md). Closed option
// sets, ids, keys, and thresholds live here; GLM only fills marked strings.
// ---------------------------------------------------------------------------

interface DecisionSet {
  /** Closed option set for the decision judge, in display order. */
  options: string[]
  /** Worst option → the human handoff (escalation recipe). */
  worst: string
  /** Default decision-judge question wording (GLM may re-word). */
  question: string
}

const DECISION_SETS: Record<string, DecisionSet> = {
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

const DEFAULT_DECISION_SET = 'quote_or_visit'

/** Deterministic thresholds. 0.85 is the sanctioned legibility exception. */
const THRESHOLDS_STANDARD = { auto: 0.9, review: 0.5 }
const THRESHOLDS_QUALITY = { auto: 0.85, review: 0.5 }

// String-slot defaults (GLM rewords; catalogue values are the fallback).
const DEFAULT_STRINGS = {
  fileUploadLabel: 'Photos of the item',
  fileUploadInstructions: 'Upload clear photos of the affected area — sharp, well-lit, whole item in frame.',
  chatPlaceholder: 'Describe what you need…',
  chatOpening: 'Tell us about the job and attach photos where helpful.',
  formLabel: 'Job details',
  formFieldLabel: 'Describe the job in your own words',
  buttonGroupLabel: 'What kind of request is this?',
  textFieldLabel: 'Anything else we should know?',
  decisionQuestion: DECISION_SETS[DEFAULT_DECISION_SET].question,
  qualityQuestion: 'How legible and complete is the submission, from 0 to 1?',
  analysisTitle: 'Summary',
  workflowName: 'Live-drafted workflow',
  workflowDescription: 'Drafted from a live discovery call; reviewed by the rep before publishing.',
}

// ---------------------------------------------------------------------------
// Screening + structure (openjev) — ONE batched closed-choice call.
// ---------------------------------------------------------------------------

interface WireQuestion {
  type: 'choice' | 'noul'
  criteria?: Record<string, string>
}

interface WireResponse {
  answers?: Record<string, { type?: string; choice?: string; confidence?: number } | undefined>
}

interface ScreenAnswers {
  materiality: ScreenOption
  confidence: number
  ops: {
    file_upload: ComponentOp
    chat: ComponentOp
    form: ComponentOp
    button_group: ComponentOp
    text_field: ComponentOp
  }
  decision_set: string
  quality_judge: boolean
}

const COMPONENT_CLASSES: { key: keyof ScreenAnswers['ops']; rubric: string }[] = [
  { key: 'file_upload', rubric: 'photo/file evidence slot — the client must submit images or documents' },
  { key: 'chat', rubric: 'conversational intake — free-form back-and-forth with the end user' },
  { key: 'form', rubric: 'structured multi-field record at intake' },
  { key: 'button_group', rubric: 'one-tap closed choice for the end user (request kind, category)' },
  { key: 'text_field', rubric: 'short typed note from the end user' },
]

function structureState(body: { transcript_digest?: string; current_spec?: WorkflowSpec | null }, segments: string[]): string {
  const digest = (body.transcript_digest ?? '').slice(0, 4000)
  const current = body.current_spec ? JSON.stringify(body.current_spec).slice(0, 3000) : '(none yet)'
  const opCriteria = Object.fromEntries(
    COMPONENT_OP_OPTIONS.map((op) => [
      op,
      op === 'keep_existing'
        ? 'The current spec already covers this; no change.'
        : op === 'add'
          ? 'The transcript indicates this part is needed and is not covered by the current spec.'
          : 'The transcript indicates this part is not needed and should be removed.',
    ]),
  )
  const decisionCriteria = Object.fromEntries([
    ...Object.entries(DECISION_SETS).map(([key, set]) => [
      key,
      `Decision type: choose among the closed set {${set.options.join(', ')}} (worst case "${set.worst}" → human review).`,
    ]),
    ['keep_current', 'The decision type in the current spec is still right (or no evidence points elsewhere).'],
  ])
  return [
    'You are the discovery-call screener and structural editor for Connective Sandbox. ' +
      'The state is a rolling digest of a sales call, the newest transcribed segments, and the ' +
      'current workflow spec. Answer every question.',
    `RUBRIC FIELDS: decision type, intake shape, judge set, escalation path. ` +
      `Intake classes under consideration: ${
        COMPONENT_CLASSES.map((entry) => `${entry.key} (${entry.rubric})`).join('; ')
      }. ` +
      `A scalar quality/legibility judge is warranted when submissions may be blurry or incomplete and a human should look.`,
    `TRANSCRIPT DIGEST SO FAR:\n${digest}`,
    `NEWEST SEGMENTS:\n${segments.map((text) => `- ${text}`).join('\n')}`,
    `CURRENT SPEC: ${current}`,
    'QUESTION CRITERIA:',
    `materiality: ${JSON.stringify({
      material_change: 'The segments introduce or alter decision type, intake shape, judge set, or escalation path.',
      minor_change: 'A refinement that does not alter structure but could improve wording or details.',
      no_change: 'Small talk, pleasantries, filler, or nothing material.',
    })}`,
    ...COMPONENT_CLASSES.map((entry) => `${entry.key}: ${JSON.stringify(opCriteria)}`),
    `decision_set: ${JSON.stringify(decisionCriteria)}`,
    'quality_judge: yes if a 0–1 legibility/quality score judge is warranted, no otherwise.',
  ].join('\n\n')
}

function parseScreenAnswer(raw: { choice?: string } | undefined, legal: readonly string[], fallback: string): string {
  const choice = raw?.choice?.toLowerCase() ?? ''
  return legal.includes(choice) ? choice : fallback
}

async function screenAndStructure(
  segments: string[],
  body: { transcript_digest?: string; current_spec?: WorkflowSpec | null },
): Promise<ScreenAnswers | { error: string }> {
  const endpoint = Deno.env.get('JUDGE_ENDPOINT_URL')
  const apiKey = Deno.env.get('JUDGE_API_KEY')
  if (!endpoint || !apiKey) return { error: 'Judge screening is not configured' }
  const model = Deno.env.get('JUDGE_MODEL') ?? 'openjev-latest'

  const questions: Record<string, WireQuestion> = {
    materiality: {
      type: 'choice',
      criteria: {
        material_change: 'Alters decision type, intake shape, judge set, or escalation path.',
        minor_change: 'A refinement that does not alter structure.',
        no_change: 'Small talk or nothing material.',
      },
    },
    decision_set: {
      type: 'choice',
      criteria: Object.fromEntries([
        ...Object.entries(DECISION_SETS).map(([key, set]) => [key, `Decision set {${set.options.join(', ')}}.`]),
        ['keep_current', 'Keep the current decision type.'],
      ]),
    },
    quality_judge: {
      type: 'choice',
      criteria: { yes: 'A 0–1 legibility/quality scalar judge is warranted.', no: 'Not warranted.' },
    },
  }
  for (const entry of COMPONENT_CLASSES) {
    questions[entry.key] = {
      type: 'choice',
      criteria: {
        keep_existing: 'Current spec already covers it; no change.',
        add: 'Needed and not covered by the current spec.',
        remove: 'Not needed; remove it.',
      },
    }
  }

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, state: structureState(body, segments), questions }),
    })
  } catch (error) {
    return { error: `Judge transport failed: ${(error as Error).message}` }
  }
  const raw = await response.text()
  if (!response.ok) return { error: `Judge endpoint returned ${response.status}: ${raw.slice(0, 300)}` }
  let parsed: WireResponse
  try {
    parsed = JSON.parse(raw) as WireResponse
  } catch {
    return { error: 'Judge response was not valid JSON' }
  }
  const answers = parsed.answers ?? {}

  const materiality = parseScreenAnswer(answers.materiality, SCREEN_OPTIONS, 'no_change')
  const ops = Object.fromEntries(
    COMPONENT_CLASSES.map((entry) => [
      entry.key,
      parseScreenAnswer(answers[entry.key], COMPONENT_OP_OPTIONS, 'keep_existing'),
    ]),
  ) as ScreenAnswers['ops']
  return {
    materiality: materiality as ScreenOption,
    confidence:
      typeof answers.materiality?.confidence === 'number' &&
      Number.isFinite(answers.materiality.confidence)
        ? Math.min(1, Math.max(0, answers.materiality.confidence))
        : 0,
    ops,
    decision_set: parseScreenAnswer(
      answers.decision_set,
      [...Object.keys(DECISION_SETS), 'keep_current'],
      'keep_current',
    ),
    quality_judge: parseScreenAnswer(answers.quality_judge, ['yes', 'no'], 'no') === 'yes',
  }
}

// ---------------------------------------------------------------------------
// Skeleton assembly — deterministic; stable parts of the current spec kept.
// ---------------------------------------------------------------------------

type StringSlots = Map<string, string>


function emptySpec(): WorkflowSpec {
  return {
    name: DEFAULT_STRINGS.workflowName,
    description: DEFAULT_STRINGS.workflowDescription,
    intake: { components: [] },
    judges: [],
    dashboard: { panels: [] },
  }
}

/**
 * Build the skeleton from the current spec + jev structural answers.
 * Returns the spec (with default strings) plus the string-slot whitelist.
 */
function assembleSkeleton(
  current: WorkflowSpec | null,
  answers: ScreenAnswers,
): { spec: WorkflowSpec; slots: StringSlots } {
  const spec: WorkflowSpec = current !== null
    ? {
        ...current,
        intake: { components: current.intake.components.map((component) => ({ ...component })) },
        judges: current.judges.map((judge) => ({ ...judge })),
        dashboard: { panels: current.dashboard.panels.map((panel) => ({ ...panel })) },
      }
    : emptySpec()
  const slots: StringSlots = new Map()

  // --- Intake components: stable parts kept, catalogue ops applied ---
  const hasClass = (klass: string) =>
    spec.intake.components.some((component) => component.type === klass)

  const applyOp = (klass: keyof ScreenAnswers['ops'], build: () => WorkflowSpec['intake']['components'][number]) => {
    const op = answers.ops[klass]
    if (op === 'add' && !hasClass(klass)) spec.intake.components.push(build())
    if (op === 'remove') {
      spec.intake.components = spec.intake.components.filter((component) => component.type !== klass)
    }
    // keep_existing: no-op
  }

  applyOp('file_upload', () => {
    slots.set('intake.components.photo_slot.label', DEFAULT_STRINGS.fileUploadLabel)
    slots.set('intake.components.photo_slot.instructions', DEFAULT_STRINGS.fileUploadInstructions)
    return {
      type: 'file_upload',
      id: 'photo_slot',
      label: DEFAULT_STRINGS.fileUploadLabel,
      accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      multiple: true,
      instructions: DEFAULT_STRINGS.fileUploadInstructions,
    }
  })
  applyOp('chat', () => {
    slots.set('intake.components.intake_chat.placeholder', DEFAULT_STRINGS.chatPlaceholder)
    slots.set('intake.components.intake_chat.opening_message', DEFAULT_STRINGS.chatOpening)
    return {
      type: 'chat',
      id: 'intake_chat',
      placeholder: DEFAULT_STRINGS.chatPlaceholder,
      opening_message: DEFAULT_STRINGS.chatOpening,
    }
  })
  applyOp('form', () => {
    slots.set('intake.components.intake_form.label', DEFAULT_STRINGS.formLabel)
    slots.set('intake.components.intake_form.fields.detail_note.label', DEFAULT_STRINGS.formFieldLabel)
    return {
      type: 'form',
      id: 'intake_form',
      label: DEFAULT_STRINGS.formLabel,
      fields: [{ id: 'detail_note', type: 'textarea', required: false, label: DEFAULT_STRINGS.formFieldLabel }],
    }
  })
  applyOp('button_group', () => {
    slots.set('intake.components.request_kind.label', DEFAULT_STRINGS.buttonGroupLabel)
    return {
      type: 'button_group',
      id: 'request_kind',
      label: DEFAULT_STRINGS.buttonGroupLabel,
      options: [
        { value: 'new_request', label: 'New request' },
        { value: 'follow_up', label: 'Follow-up' },
      ],
      multi: false,
    }
  })
  applyOp('text_field', () => {
    slots.set('intake.components.short_note.label', DEFAULT_STRINGS.textFieldLabel)
    return { type: 'text_field', id: 'short_note', label: DEFAULT_STRINGS.textFieldLabel, multiline: false }
  })

  // An intake surface must exist; the chat component is the universal intake.
  if (spec.intake.components.length === 0) {
    slots.set('intake.components.intake_chat.placeholder', DEFAULT_STRINGS.chatPlaceholder)
    slots.set('intake.components.intake_chat.opening_message', DEFAULT_STRINGS.chatOpening)
    spec.intake.components.push({
      type: 'chat',
      id: 'intake_chat',
      placeholder: DEFAULT_STRINGS.chatPlaceholder,
      opening_message: DEFAULT_STRINGS.chatOpening,
    })
  }

  // --- Judges: decision judge from the closed catalogue set + optional
  //     scalar quality judge; other existing judges are stable parts. ---
  const stateFrom = spec.intake.components.map((component) => component.id)
  const chosenSet = answers.decision_set !== 'keep_current' && answers.decision_set in DECISION_SETS
    ? answers.decision_set
    : null

  if (chosenSet !== null || !spec.judges.some((judge) => judge.id === 'decision_judge')) {
    const key = chosenSet ?? DEFAULT_DECISION_SET
    const set = DECISION_SETS[key]
    // Replace any prior catalogue decision judge; keep foreign judges.
    spec.judges = spec.judges.filter((judge) => judge.id !== 'decision_judge')
    const decisionQuestion = DEFAULT_STRINGS.decisionQuestion
    slots.set('judges.decision_judge.question', decisionQuestion)
    const decisionJudge: Judge = {
      id: 'decision_judge',
      state_from: stateFrom,
      question: decisionQuestion,
      question_type: 'choice',
      options: [...set.options],
      thresholds: { ...THRESHOLDS_STANDARD },
    }
    const index = spec.judges.findIndex((judge) => judge.question_type === 'choice')
    if (index >= 0) spec.judges.splice(index, 0, decisionJudge)
    else spec.judges.unshift(decisionJudge)
  } else {
    slots.set('judges.decision_judge.question', spec.judges.find((judge) => judge.id === 'decision_judge')?.question ?? DEFAULT_STRINGS.decisionQuestion)
  }

  const hasQuality = spec.judges.some((judge) => judge.id === 'quality_score')
  if (answers.quality_judge && !hasQuality) {
    slots.set('judges.quality_score.question', DEFAULT_STRINGS.qualityQuestion)
    spec.judges.push({
      id: 'quality_score',
      state_from: stateFrom,
      question: DEFAULT_STRINGS.qualityQuestion,
      question_type: 'scalar',
      thresholds: { ...THRESHOLDS_QUALITY },
    })
  }

  // --- Dashboard: derived deterministically from the final judge set. ---
  const panels: WorkflowSpec['dashboard']['panels'] = spec.judges.map((judge) => ({
    type: 'confidence_meter' as const,
    id: `confidence_${judge.id}`,
    judge_id: judge.id,
    label: judge.id === 'quality_score' ? 'Submission quality' : 'Decision confidence',
  }))
  slots.set('dashboard.panels.analysis.title', DEFAULT_STRINGS.analysisTitle)
  panels.push({ type: 'analysis', id: 'summary', title: DEFAULT_STRINGS.analysisTitle, source: 'llm' })
  panels.push({ type: 'decision_log', id: 'ownership_log', limit: 20 })
  panels.push({ type: 'usage_counter', id: 'runs', label: 'Workflow runs' })
  spec.dashboard = { panels }

  slots.set('name', DEFAULT_STRINGS.workflowName)
  slots.set('description', DEFAULT_STRINGS.workflowDescription)
  return { spec, slots }
}

// ---------------------------------------------------------------------------
// GLM strings-only pass. The slot map is a whitelist: only offered paths,
// only string values, sane length caps. Structure cannot be altered.
// ---------------------------------------------------------------------------

const SLOT_LIMITS: Record<string, number> = { name: 80, description: 400 }
const DEFAULT_SLOT_LIMIT = 300

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

function applyStrings(spec: WorkflowSpec, slots: StringSlots, strings: Record<string, unknown>): WorkflowSpec {
  for (const [path, value] of Object.entries(strings)) {
    if (!slots.has(path) || typeof value !== 'string') continue
    const trimmed = value.trim()
    const limit = SLOT_LIMITS[path] ?? DEFAULT_SLOT_LIMIT
    if (trimmed.length === 0 || trimmed.length > limit) continue
    setAtPath(spec, path, trimmed)
  }
  return spec
}

/** Set a whitelisted string slot by catalogue path (e.g. 'intake.components.photo_slot.label'). */
function setAtPath(spec: WorkflowSpec, path: string, value: string): void {
  // Catalogue component/field paths are id-keyed, not index-keyed, so they
  // stay stable regardless of assembly order.
  const componentMatch = path.match(/^intake\.components\.([a-z_]+)\.(.+)$/)
  if (componentMatch !== null) {
    const component = spec.intake.components.find((entry) => entry.id === componentMatch[1])
    if (component === undefined) return
    const fieldPath = componentMatch[2]
    const fieldMatch = fieldPath.match(/^fields\.([a-z_]+)\.label$/)
    if (fieldMatch !== undefined && component.type === 'form') {
      const field = component.fields.find((entry) => entry.id === fieldMatch[1])
      if (field !== undefined) {
        field.label = value
        return
      }
      return
    }
    if (fieldPath === 'label' || fieldPath === 'instructions' || fieldPath === 'placeholder' || fieldPath === 'opening_message') {
      ;(component as Record<string, unknown>)[fieldPath] = value
      return
    }
    return
  }
  const judgeMatch = path.match(/^judges\.([a-z_]+)\.question$/)
  if (judgeMatch !== null) {
    const judge = spec.judges.find((entry) => entry.id === judgeMatch[1])
    if (judge !== undefined) judge.question = value
    return
  }
  const panelMatch = path.match(/^dashboard\.panels\.([a-z_]+)\.title$/)
  if (panelMatch !== null) {
    const panel = spec.dashboard.panels.find((entry) => entry.id === panelMatch[1])
    if (panel !== undefined && panel.type === 'analysis') panel.title = value
    return
  }
  if (path === 'name' || path === 'description') {
    ;(spec as unknown as Record<string, unknown>)[path] = value
    return
  }
}

function stringsPrompt(spec: WorkflowSpec, slots: StringSlots): GlmMessage[] {
  const offered = [...slots.entries()]
    .map(([path, current]) => `"${path}": "${current.replace(/"/g, '\\"')}"`)
    .join(',\n')
  const user = [
    'A workflow spec skeleton was assembled from legal catalogue parts. Its STRUCTURE is final — ' +
      'you may NOT add, remove, reorder, or re-key anything, and you may NOT change any option set or threshold.',
    'Fill the string slots below with natural, brand-consistent copy for the client. ' +
      'Reply with ONE JSON object mapping slot path → string and NOTHING else. ' +
      'Keep every value short and plain; do not add new slots.',
    `CONTEXT — the assembled spec:\n${JSON.stringify(spec, null, 2).slice(0, 5000)}`,
    `SLOTS (path: current default):\n${offered}`,
  ].join('\n\n')
  return [
    { role: 'system', content: 'You fill string slots in a fixed workflow spec. Output one JSON object only.' },
    { role: 'user', content: user },
  ]
}

// ---------------------------------------------------------------------------
// Draft assembly orchestration: skeleton → GLM strings → hard Zod gate.
// ---------------------------------------------------------------------------

async function draftSpec(
  body: { transcript_digest?: string; current_spec?: WorkflowSpec | null },
  answers: ScreenAnswers,
): Promise<{ ok: true; spec: WorkflowSpec } | { ok: false; error: string }> {
  const assembled = assembleSkeleton(body.current_spec ?? null, answers)
  try {
    const strings = await glmChat(stringsPrompt(assembled.spec, assembled.slots), { maxTokens: 2048 })
    const map = extractJsonMap(strings)
    if (map !== null) applyStrings(assembled.spec, assembled.slots, map)
  } catch (error) {
    // GLM is unavailable or junky: catalogue default strings still validate.
    console.log(`[live-draft] GLM strings pass skipped: ${(error as Error).message}`)
  }
  let result = safeParseWorkflowSpec(assembled.spec)
  if (result.success) return { ok: true, spec: result.data }
  console.log(`[live-draft] assembled spec invalid: ${result.error.issues[0]?.message}`)
  // Retry deterministically: default strings only (GLM output fully dropped).
  const fallback = assembleSkeleton(body.current_spec ?? null, answers)
  result = safeParseWorkflowSpec(fallback.spec)
  if (result.success) return { ok: true, spec: result.data }
  return { ok: false, error: formatZodError(result.error) }
}

function formatZodError(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

// ---------------------------------------------------------------------------
// Rate guard — durable token bucket keyed on (client_id, session_id).
// ---------------------------------------------------------------------------

async function draftCooldownActive(clientId: string, sessionId: string): Promise<boolean> {
  const cooldownSeconds = Number(Deno.env.get('DRAFT_COOLDOWN_SECONDS') ?? '15')
  const rows = await restSelect<{ created_at: string }>('spec_drafts', {
    client_id: `eq.${clientId}`,
    session_id: `eq.${sessionId}`,
    select: 'created_at',
    order: 'created_at.desc',
    limit: '1',
  })
  if (rows.length === 0) return false
  const last = Date.parse(rows[0].created_at)
  if (Number.isNaN(last)) return false
  return Date.now() - last < cooldownSeconds * 1000
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

interface LiveDraftBody {
  client_id?: string
  workflow_id?: string | null
  session_id?: string
  transcript_digest?: string
  new_segments?: SegmentInput[]
  current_spec?: WorkflowSpec | null
}

function segmentTexts(newSegments: SegmentInput[]): string[] {
  return newSegments
    .map((segment) => (typeof segment?.text === 'string' ? segment.text.trim() : ''))
    .filter((text) => text.length > 0)
    .slice(0, MAX_SEGMENTS_PER_CALL)
}

function deltaSummary(choice: ScreenOption, segments: string[]): string {
  const latest = segments[segments.length - 1] ?? ''
  const snippet = latest.length > 80 ? `${latest.slice(0, 77)}…` : latest
  if (choice === 'material_change') return `Material change — “${snippet}”`
  if (choice === 'minor_change') return `Refinement — “${snippet}”`
  return 'No material change'
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return handleOptions(request)

  const session = await readSession(request)
  if (!session) return jsonResponse(request, { error: 'Not authenticated' }, 401)
  if (session.app_role !== 'admin') return jsonResponse(request, { error: 'Admin session required' }, 403)

  const url = new URL(request.url)

  try {
    // ---------------------------------------------------------------
    // GET — list drafts (admin only)
    // ---------------------------------------------------------------
    if (request.method === 'GET') {
      const workflowId = url.searchParams.get('workflow_id') ?? ''
      if (!UUID_RE.test(workflowId)) {
        return jsonResponse(request, { error: 'workflow_id is required' }, 400)
      }
      const drafts = await restSelect<Record<string, unknown>>('spec_drafts', {
        workflow_id: `eq.${workflowId}`,
        select: 'id,client_id,workflow_id,version,spec,delta_summary,source,published,created_at',
        order: 'version.desc',
      })
      return jsonResponse(request, { drafts })
    }

    // ---------------------------------------------------------------
    // PATCH — flip the published flag after the existing publish path
    // ---------------------------------------------------------------
    if (request.method === 'PATCH') {
      const body = await request.json()
      const draftId = typeof body?.draft_id === 'string' ? body.draft_id : ''
      if (!UUID_RE.test(draftId)) return jsonResponse(request, { error: 'draft_id is required' }, 400)
      const updated = await restUpdate<{ id: string; published: boolean }>(
        'spec_drafts',
        { id: `eq.${draftId}` },
        { published: body?.published === true },
      )
      if (updated.length === 0) return jsonResponse(request, { error: 'Not found' }, 404)
      return jsonResponse(request, { draft: updated[0] })
    }

    // ---------------------------------------------------------------
    // DELETE — discard a draft
    // ---------------------------------------------------------------
    if (request.method === 'DELETE') {
      const draftId = url.searchParams.get('draft_id') ?? ''
      if (!UUID_RE.test(draftId)) return jsonResponse(request, { error: 'draft_id is required' }, 400)
      await restDelete('spec_drafts', { id: `eq.${draftId}` })
      return jsonResponse(request, { ok: true })
    }

    // ---------------------------------------------------------------
    // POST — persist segments, screen + structure, maybe draft
    // ---------------------------------------------------------------
    if (request.method !== 'POST') {
      return jsonResponse(request, { error: 'Unsupported method' }, 405)
    }

    const body = await request.json() as LiveDraftBody
    const clientId = typeof body.client_id === 'string' ? body.client_id : ''
    const sessionId = typeof body.session_id === 'string' ? body.session_id.slice(0, 120) : ''
    const workflowId = typeof body.workflow_id === 'string' && UUID_RE.test(body.workflow_id)
      ? body.workflow_id
      : null
    if (!UUID_RE.test(clientId) || sessionId.length === 0) {
      return jsonResponse(request, { error: 'client_id and session_id are required' }, 400)
    }
    const segments = segmentTexts(Array.isArray(body.new_segments) ? body.new_segments : [])
    if (segments.length === 0) {
      return jsonResponse(request, { error: 'new_segments with text are required' }, 400)
    }

    // 1. Persist the transcript segments (durability; nothing client-visible).
    const indexed = body.new_segments?.every?.((segment) => typeof segment?.segment_index === 'number') ?? false
    await restInsert('transcript_segments', segments.map((text, index) => ({
      client_id: clientId,
      ...(workflowId !== null ? { workflow_id: workflowId } : {}),
      session_id: sessionId,
      segment_index: indexed ? body.new_segments?.[index]?.segment_index : index,
      text,
    })))

    // 2. Screen + structure — ONE batched openjev classification call.
    const screening = await screenAndStructure(segments, body)
    if ('error' in screening) {
      return jsonResponse(request, { changed: false, error: screening.error }, 502)
    }
    const changed = screening.materiality !== 'no_change'
    const delta = deltaSummary(screening.materiality, segments)
    const summary = {
      changed,
      delta_summary: delta,
      screen_choice: screening.materiality,
      screen_confidence: screening.confidence,
    }
    if (!changed) return jsonResponse(request, summary)

    // 3. Rate guard before any draft spend.
    if (await draftCooldownActive(clientId, sessionId)) {
      return jsonResponse(request, { ...summary, draft_suppressed: true })
    }

    // 4. Assemble the skeleton, let GLM fill strings, hard-gate on Zod.
    let drafted: { ok: true; spec: WorkflowSpec } | { ok: false; error: string }
    try {
      drafted = await draftSpec(body, screening)
    } catch (error) {
      drafted = { ok: false, error: `Draft generation failed: ${(error as Error).message}` }
    }
    if (!drafted.ok) {
      return jsonResponse(request, { ...summary, draft_error: drafted.error })
    }
    const version = await nextDraftVersion(clientId, workflowId, sessionId)
    const inserted = await restInsert<{ id: string; version: number }>('spec_drafts', {
      client_id: clientId,
      session_id: sessionId,
      ...(workflowId !== null ? { workflow_id: workflowId } : {}),
      version,
      spec: drafted.spec,
      delta_summary: delta,
      source: 'transcript',
      published: false,
    })
    return jsonResponse(request, {
      ...summary,
      draft_spec: drafted.spec,
      draft_version: inserted[0]?.version ?? version,
      draft_id: inserted[0]?.id ?? null,
    })
  } catch (error) {
    console.error('[live-draft] error:', error instanceof Error ? error.message : error)
    return jsonResponse(request, { error: 'Internal error' }, 500)
  }
})
