// feedback — the client feedback channel gateway.
//
// Clients message their service team from the workspace; every client
// message is dual-output: stored for the rep's service thread AND run
// through the parallel-AI edit pipeline (openjev classification → for
// wording/structure, the planner adapter proposes a versioned spec draft,
// source='feedback'). The AI never sends client-facing text and never
// publishes — the rep is the UAT gate via the admin Inbox.
//
//   GET ?threads=1                      (admin)  thread list: per client, last
//                                                message preview, unread count,
//                                                latest classification
//   GET ?client_id=<uuid>               (admin)  one thread: messages + proposed
//                                                drafts + published change log;
//                                                marks the thread read
//   GET                                 (client) own messages (asc); marks read
//   POST { body, workflow_id?, attachments? }     (client) store + classify +
//                                                maybe draft (planner adapter)
//   POST { client_id, body }            (admin)  rep reply in-thread — the rep
//                                                is the client-facing voice
//
// Classification: ONE batched openjev call into the closed set
// wording | structure | accuracy | feature_request | bug | question.
// accuracy rows also record the referenced judge when identifiable (they are
// evaluation data — never auto-fixable; the pipeline may propose only a
// bounded threshold tweak for rep review). Classification failure falls back
// to 'question' + classification_fallback — the message is never lost.
//
// Rate guard: planner invocations are bounded per client per hour
// (FEEDBACK_PLANNER_MAX_PER_HOUR, default 5), counted durably from
// feedback_messages so it survives isolate recycling. A suppressed message is
// still stored and classified — only the draft spend is held back.
//
// RLS on feedback_messages is default-deny; every read/write here is scoped
// by the verified session cookie and executed with service_role (Phase 5
// gateway pattern).

import { handleOptions, jsonResponse } from '../_shared/cors.ts'
import { readSession } from '../_shared/jwt.ts'
import { restCount, restInsert, restSelect, restUpdate } from '../_shared/rest.ts'
import { applyProposal, resolvePlanner } from '../_shared/planner.ts'

import { safeParseWorkflowSpec } from '../../../src/engine/schema.ts'
import type { WorkflowSpec } from '../../../src/engine/types.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_CHARS = 4000
const MAX_ATTACHMENTS = 6

const CLASSIFICATIONS = ['wording', 'structure', 'accuracy', 'feature_request', 'bug', 'question'] as const
type Classification = (typeof CLASSIFICATIONS)[number]

interface FeedbackMessageRow {
  id: string
  client_id: string
  workflow_id: string | null
  direction: 'client' | 'rep'
  body: string
  attachments: { artifact_id?: unknown; filename?: unknown }[]
  classification: Classification | null
  confidence: number | null
  referenced_judge: string | null
  classification_fallback: boolean
  read_by_rep: boolean
  read_by_client: boolean
  created_at: string
}

interface DraftRow {
  id: string
  client_id: string
  workflow_id: string | null
  version: number
  spec: WorkflowSpec
  delta_summary: string
  source: string
  published: boolean
  feedback_message_id: string | null
  created_at: string
}

const DRAFT_COLUMNS = 'id,client_id,workflow_id,version,spec,delta_summary,source,published,feedback_message_id,created_at'
const MESSAGE_COLUMNS =
  'id,client_id,workflow_id,direction,body,attachments,classification,confidence,referenced_judge,classification_fallback,read_by_rep,read_by_client,created_at'

// ---------------------------------------------------------------------------
// Classification — ONE batched openjev call, closed sets only.
// ---------------------------------------------------------------------------

interface WireResponse {
  answers?: Record<string, { choice?: string; confidence?: number } | undefined>
}

const CLASSIFICATION_CRITERIA: Record<Classification, string> = {
  wording: "The client is happy with the workflow's structure but wants different wording — labels, hints, questions, option names, or descriptions read wrong or unclear.",
  structure: 'The client wants a different intake structure — a step missing, a step that should not be there, or a different way of capturing the same information.',
  accuracy: "The client says the workflow's decision or scoring was WRONG for their submission (mis-classified, wrong outcome, wrong confidence). Evaluation data, not a wording or structure wish.",
  feature_request: 'The client asks for something new the workflow cannot express — a capability, integration, report, or behaviour change beyond re-wording or intake structure.',
  bug: 'The client reports something broken — an error, a crash, a stuck upload, or behaviour that is clearly faulty rather than debatable.',
  question: 'A question or general comment that is not a change request or a fault report.',
}

async function classify(
  body: string,
  threadContext: string,
  spec: WorkflowSpec | null,
): Promise<{ classification: Classification; confidence: number; referencedJudge: string | null } | { error: string }> {
  const endpoint = Deno.env.get('JUDGE_ENDPOINT_URL')
  const apiKey = Deno.env.get('JUDGE_API_KEY')
  if (!endpoint || !apiKey) return { error: 'Judge endpoint is not configured' }
  const model = Deno.env.get('JUDGE_MODEL') ?? 'openjev-latest'

  const questions: Record<string, { type: 'choice'; criteria: Record<string, string> }> = {
    classification: { type: 'choice', criteria: CLASSIFICATION_CRITERIA },
  }
  if (spec !== null && spec.judges.length > 0) {
    questions.accuracy_target = {
      type: 'choice',
      criteria: Object.fromEntries([
        ...spec.judges.map((judge) => [judge.id, `The feedback refers to this judge: "${judge.question.slice(0, 120)}".`]),
        ['unclear', 'The feedback does not clearly point at one judge.'],
      ]),
    }
  }

  const specDigest = spec !== null
    ? JSON.stringify({
        name: spec.name,
        components: spec.intake.components.map((component) => ({ type: component.type, id: component.id })),
        judges: spec.judges.map((judge) => ({ id: judge.id, question: judge.question, thresholds: judge.thresholds })),
      })
    : '(no workflow attached)'
  const state = [
    'You classify client feedback about their service-team intake workflow. Read the feedback in the light of the recent thread and the workflow summary, then answer every question.',
    `WORKFLOW SUMMARY: ${specDigest}`,
    `RECENT THREAD:\n${threadContext}`,
    `NEW CLIENT FEEDBACK:\n"""${body.slice(0, 2000)}"""`,
  ].join('\n\n')

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
  if (!response.ok) return { error: `Judge endpoint returned ${response.status}: ${raw.slice(0, 200)}` }
  let parsed: WireResponse
  try {
    parsed = JSON.parse(raw) as WireResponse
  } catch {
    return { error: 'Judge response was not valid JSON' }
  }
  const answers = parsed.answers ?? {}
  const choice = answers.classification?.choice?.toLowerCase() ?? ''
  if (!CLASSIFICATIONS.includes(choice as Classification)) {
    return { error: `Judge returned an out-of-set classification: ${choice.slice(0, 40) || '(empty)'}` }
  }
  const confidence =
    typeof answers.classification?.confidence === 'number' && Number.isFinite(answers.classification.confidence)
      ? Math.min(1, Math.max(0, answers.classification.confidence))
      : 0
  const legalJudges = spec?.judges.map((judge) => judge.id) ?? []
  const target = answers.accuracy_target?.choice ?? ''
  return {
    classification: choice as Classification,
    confidence,
    referencedJudge: choice === 'accuracy' && legalJudges.includes(target) ? target : null,
  }
}

// ---------------------------------------------------------------------------
// Planner pipeline (wording / structure only)
// ---------------------------------------------------------------------------

async function loadSpec(workflowId: string | null): Promise<WorkflowSpec | null> {
  if (workflowId === null) return null
  const rows = await restSelect<{ spec: unknown }>('workflows', {
    id: `eq.${workflowId}`,
    select: 'spec',
    limit: '1',
  })
  if (rows.length === 0) return null
  const parsed = safeParseWorkflowSpec(rows[0].spec)
  return parsed.success ? parsed.data : null
}

async function plannerBudgetReached(clientId: string): Promise<boolean> {
  const max = Number(Deno.env.get('FEEDBACK_PLANNER_MAX_PER_HOUR') ?? '5')
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const count = await restCount('feedback_messages', {
    client_id: `eq.${clientId}`,
    classification: `in.(wording,structure)`,
    created_at: `gte.${since}`,
  })
  return count >= max
}

async function nextDraftVersion(clientId: string, workflowId: string | null): Promise<number> {
  const params: Record<string, string> = {
    client_id: `eq.${clientId}`,
    source: `eq.feedback`,
    select: 'version',
    order: 'version.desc',
    limit: '1',
  }
  if (workflowId !== null) params.workflow_id = `eq.${workflowId}`
  const rows = await restSelect<{ version: number }>('spec_drafts', params)
  return (rows[0]?.version ?? 0) + 1
}

async function planDraft(
  clientId: string,
  workflowId: string | null,
  messageId: string,
  feedback: string,
  classification: 'wording' | 'structure',
  currentSpec: WorkflowSpec | null,
): Promise<{ draft?: DraftRow; error?: string; suppressed?: boolean }> {
  const spec = currentSpec ?? { name: 'Workflow', description: '', intake: { components: [] }, judges: [], dashboard: { panels: [] } }
  let proposal
  try {
    proposal = await resolvePlanner().plan({ feedback, classification, currentSpec: spec })
  } catch (error) {
    return { error: `Planner failed: ${(error as Error).message}` }
  }
  const { spec: candidate, applied } = applyProposal(spec, proposal)
  if (applied.length === 0) return {} // nothing to propose — no draft spend
  let result = safeParseWorkflowSpec(candidate)
  if (!result.success) {
    // Deterministic retry: drop every planner string, keep the structural ops.
    const retry = applyProposal(spec, { ...proposal, strings: {} })
    result = safeParseWorkflowSpec(retry.spec)
    if (!result.success) {
      return { error: `Proposed spec failed schema validation` }
    }
    return await insertDraft(clientId, workflowId, messageId, retry.spec, retry.applied)
  }
  return await insertDraft(clientId, workflowId, messageId, result.data, applied)
}

async function insertDraft(
  clientId: string,
  workflowId: string | null,
  messageId: string,
  spec: WorkflowSpec,
  applied: string[],
): Promise<{ draft?: DraftRow; error?: string }> {
  const summary = applied.length > 0 ? applied.join('; ').replace(/^./, (char) => char.toUpperCase()) : 'Refinement proposed'
  const version = await nextDraftVersion(clientId, workflowId)
  const inserted = await restInsert<DraftRow>('spec_drafts', {
    client_id: clientId,
    ...(workflowId !== null ? { workflow_id: workflowId } : {}),
    version,
    spec,
    delta_summary: summary,
    source: 'feedback',
    published: false,
    feedback_message_id: messageId,
  })
  return { draft: inserted[0] }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeAttachments(input: unknown): { artifact_id: string; filename: string }[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      artifact_id: typeof entry.artifact_id === 'string' && UUID_RE.test(entry.artifact_id) ? entry.artifact_id : '',
      filename: typeof entry.filename === 'string' ? entry.filename.replace(/[^\w .-]/g, '').slice(0, 120) : '',
    }))
    .filter((entry) => entry.artifact_id !== '' && entry.filename !== '')
    .slice(0, MAX_ATTACHMENTS)
}

function threadContext(rows: FeedbackMessageRow[]): string {
  return rows
    .slice(-6)
    .map((row) => `${row.direction === 'client' ? 'Client' : 'Rep'}: ${row.body.slice(0, 300)}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return handleOptions(request)

  const session = await readSession(request)
  if (!session) return jsonResponse(request, { error: 'Not authenticated' }, 401)
  const isAdmin = session.app_role === 'admin'
  const clientId = session.client_id ?? null
  if (!isAdmin && clientId === null) return jsonResponse(request, { error: 'Client session required' }, 403)

  const url = new URL(request.url)

  try {
    // ---------------------------------------------------------------
    // GET — thread list (admin), one thread (admin), own thread (client)
    // ---------------------------------------------------------------
    if (request.method === 'GET') {
      // Admin thread list: per-client last message + unread + classification.
      if (isAdmin && url.searchParams.get('threads') === '1') {
        const rows = await restSelect<FeedbackMessageRow & { client_name?: string }>('feedback_messages', {
          select: `${MESSAGE_COLUMNS},clients!inner(name)`,
          order: 'created_at.desc',
          limit: '500',
        })
        const threads = new Map<string, {
          client_id: string
          client_name: string
          last_message: string
          last_at: string
          last_direction: string
          unread: number
          latest_classification: string | null
        }>()
        for (const row of rows) {
          const name = (row as { clients?: { name?: string } }).clients?.name ?? ''
          const existing = threads.get(row.client_id)
          if (existing === undefined) {
            threads.set(row.client_id, {
              client_id: row.client_id,
              client_name: name,
              last_message: row.body.slice(0, 120),
              last_at: row.created_at,
              last_direction: row.direction,
              unread: 0,
              latest_classification: row.classification,
            })
          }
          const thread = threads.get(row.client_id)!
          if (row.direction === 'client' && !row.read_by_rep) thread.unread += 1
        }
        return jsonResponse(request, { threads: [...threads.values()] })
      }

      // Admin opens one thread (marks read for the rep, then selects so the
      // returned rows carry the fresh flags).
      if (isAdmin) {
        const targetId = url.searchParams.get('client_id') ?? ''
        if (!UUID_RE.test(targetId)) return jsonResponse(request, { error: 'client_id is required' }, 400)
        await restUpdate('feedback_messages', { client_id: `eq.${targetId}`, direction: `eq.client`, read_by_rep: `eq.false` }, { read_by_rep: true })
        const messages = await restSelect<FeedbackMessageRow>('feedback_messages', {
          client_id: `eq.${targetId}`,
          select: MESSAGE_COLUMNS,
          order: 'created_at.asc',
          limit: '500',
        })
        const drafts = await restSelect<DraftRow>('spec_drafts', {
          client_id: `eq.${targetId}`,
          source: `eq.feedback`,
          select: DRAFT_COLUMNS,
          order: 'created_at.desc',
          limit: '50',
        })
        return jsonResponse(request, { messages, drafts })
      }

      // Client reads their own thread (marks the rep's replies read, then
      // selects so the returned rows carry the fresh flags).
      await restUpdate('feedback_messages', { client_id: `eq.${clientId}`, direction: `eq.rep`, read_by_client: `eq.false` }, { read_by_client: true })
      const messages = await restSelect<FeedbackMessageRow>('feedback_messages', {
        client_id: `eq.${clientId}`,
        select: MESSAGE_COLUMNS,
        order: 'created_at.asc',
        limit: '500',
      })
      return jsonResponse(request, { messages })
    }

    // ---------------------------------------------------------------
    // POST — client feedback (store + classify + maybe draft) or rep reply
    // ---------------------------------------------------------------
    if (request.method === 'POST') {
      const body = await request.json() as {
        body?: unknown
        workflow_id?: unknown
        attachments?: unknown
        client_id?: unknown
      }
      const text = typeof body.body === 'string' ? body.body.trim().slice(0, MAX_BODY_CHARS) : ''
      if (text.length === 0) return jsonResponse(request, { error: 'body is required' }, 400)

      // --- Rep reply: the only client-facing human voice. ---
      if (isAdmin) {
        const targetId = typeof body.client_id === 'string' && UUID_RE.test(body.client_id) ? body.client_id : ''
        if (targetId === '') return jsonResponse(request, { error: 'client_id is required' }, 400)
        const inserted = await restInsert<FeedbackMessageRow>('feedback_messages', {
          client_id: targetId,
          direction: 'rep',
          body: text,
          read_by_rep: true,
        })
        return jsonResponse(request, { message: inserted[0] }, 201)
      }

      // --- Client feedback: store, then classify, then maybe draft. ---
      let workflowId = typeof body.workflow_id === 'string' && UUID_RE.test(body.workflow_id) ? body.workflow_id : null
      if (workflowId !== null) {
        const owned = await restSelect<{ id: string }>('workflows', {
          id: `eq.${workflowId}`,
          client_id: `eq.${clientId}`,
          select: 'id',
          limit: '1',
        })
        // Unowned workflow ids are dropped — the message is never rejected.
        if (owned.length === 0) workflowId = null
      }
      const attachments = sanitizeAttachments(body.attachments)
      const inserted = await restInsert<FeedbackMessageRow>('feedback_messages', {
        client_id: clientId,
        ...(workflowId !== null ? { workflow_id: workflowId } : {}),
        direction: 'client',
        body: text,
        attachments,
        read_by_rep: false,
        read_by_client: true,
      })
      const message = inserted[0]
      if (message === undefined) return jsonResponse(request, { error: 'Could not store the message' }, 500)

      // Classify — ONE batched openjev call. Failure falls back to
      // 'question' + flag; the message is never lost.
      const recent = await restSelect<FeedbackMessageRow>('feedback_messages', {
        client_id: `eq.${clientId}`,
        select: MESSAGE_COLUMNS,
        order: 'created_at.desc',
        limit: '6',
      })
      const spec = await loadSpec(workflowId)
      const outcome = await classify(text, threadContext(recent.reverse()), spec)
      let classification: Classification
      let confidence: number
      let referencedJudge: string | null = null
      let fallback = false
      if ('error' in outcome) {
        console.log(`[feedback] classification failed: ${outcome.error}`)
        classification = 'question'
        confidence = 0
        fallback = true
      } else {
        classification = outcome.classification
        confidence = outcome.confidence
        referencedJudge = outcome.referencedJudge
      }

      const updated = await restUpdate<FeedbackMessageRow>(
        'feedback_messages',
        { id: `eq.${message.id}` },
        {
          classification,
          confidence,
          referenced_judge: referencedJudge,
          classification_fallback: fallback,
        },
      )

      const payload: Record<string, unknown> = {
        message: updated[0] ?? message,
        classification,
        confidence,
        classification_fallback: fallback,
      }

      // Dual output: wording/structure drive the planner pipeline.
      if ((classification === 'wording' || classification === 'structure') && !fallback) {
        if (await plannerBudgetReached(clientId)) {
          payload.planner_suppressed = true
        } else {
          try {
            const planned = await planDraft(clientId, workflowId, message.id, text, classification, spec)
            if (planned.suppressed === true) payload.planner_suppressed = true
            if (planned.draft !== undefined) {
              payload.draft = {
                id: planned.draft.id,
                version: planned.draft.version,
                delta_summary: planned.draft.delta_summary,
              }
            }
            if (planned.error !== undefined) payload.draft_error = planned.error
          } catch (error) {
            console.log(`[feedback] planner pipeline failed: ${(error as Error).message}`)
            payload.draft_error = `Planner pipeline failed`
          }
        }
      } else if (classification === 'accuracy' && referencedJudge !== null) {
        payload.referenced_judge = referencedJudge
      }
      return jsonResponse(request, payload, 201)
    }

    return jsonResponse(request, { error: 'Unsupported method' }, 405)
  } catch (error) {
    console.error('[feedback] error:', error instanceof Error ? error.message : error)
    return jsonResponse(request, { error: 'Internal error' }, 500)
  }
})
