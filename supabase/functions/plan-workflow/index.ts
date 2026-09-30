// plan-workflow — the GLM planning stage (Phase 3). The rep gives a brief
// (plus, automatically, the most recent discovery-call transcript when one
// exists); the planner decides WHAT to build: which library template, which
// modules, which slot-level customisations for THIS client, and what is still
// open. The plan is then compiled DETERMINISTICALLY — the model never
// touches the spec.
//
//   POST /plan-workflow { workflow_id, client_id, brief, transcript_session_id? }
//
// Pipeline:
//   1. verify the admin JWT cookie (admin only)
//   2. rate guard: plan drafts per client per hour (PLAN_MAX_PER_HOUR, default
//      10) counted durably from spec_drafts — survives isolate recycling
//   3. assemble context: client identity + existing workflows (never rebuild
//      what exists), template candidates (curated + library, slot keys
//      included so every customisation names a REAL slot), and the transcript
//      tail (explicit session_id, else the client's most recent call within
//      TRANSCRIPT_MAX_AGE_DAYS — automatic, no picker)
//   4. ONE GLM-5.3-Flash call (reasoning_effort 'low' by default — the
//      compile is deterministic and rep-gated, so speed wins) returning a
//      WorkflowPlan validated against src/engine/plan.ts (max 3
//      self-correction rounds)
//   5. compile: chosen template + plan customisations through
//      applySlotValues — unknown slot keys and out-of-band values drop
//      deterministically; the frozen Zod schema gates the result
//   6. persist a spec_drafts row (source='plan', plan jsonb attached) and
//      sync the workflow row's name/description so the rail reads well
//   7. respond { plan, draft, applied }
//
// Secrets stay server-side (invariant 5); the plan is advice — the rep stays
// the UAT gate and publishes through the normal path.

import { handleOptions, jsonResponse } from '../_shared/cors.ts'
import { readSession } from '../_shared/jwt.ts'
import { restCount, restInsert, restSelect, restUpdate } from '../_shared/rest.ts'
import { glmChat } from '../_shared/glm.ts'
import { INTAKE_KINDS, PANEL_KINDS } from '../_shared/planner.ts'

import { safeParseWorkflowPlan, type WorkflowPlan } from '../../../src/engine/plan.ts'
import { safeParseWorkflowSpec } from '../../../src/engine/schema.ts'
import { compileSpec } from '../../../src/engine/compilers.ts'
import { applySlotValues, type TemplateSlot } from '../../../src/engine/templating.ts'
import type { WorkflowSpec } from '../../../src/engine/types.ts'
import type { FactStateEntry } from '../../../src/engine/facts.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ROUNDS = 3
const MAX_CANDIDATES = 8
const MAX_TRANSCRIPT_LINES = 30
const MAX_BRIEF_CHARS = 4000
/** Auto-attach a transcript only when the call is recent. */
const TRANSCRIPT_MAX_AGE_DAYS = 7

function envNumber(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const PLAN_MAX_PER_HOUR = envNumber('PLAN_MAX_PER_HOUR', 10)

function planReasoningEffort(): 'low' | 'high' | 'max' {
  const value = Deno.env.get('PLAN_REASONING_EFFORT')
  return value === 'high' || value === 'max' ? value : 'low'
}

interface TemplateRow {
  id: string
  name: string
  description: string | null
  category: string
  version: number
  spec: Record<string, unknown>
  slots: TemplateSlot[]
  is_curated: boolean
}

/** Module-kind summary + slot keys for one candidate (compact for GLM). */
function candidateSummary(row: TemplateRow) {
  const spec = row.spec as unknown as WorkflowSpec | null
  const intake = spec ? [...new Set(spec.intake.components.map((component) => component.type))] : []
  const dashboard = spec ? [...new Set(spec.dashboard.panels.map((panel) => panel.type))] : []
  const slotKeys = (row.slots ?? [])
    .filter((slot) => slot.group !== 'identity')
    .map((slot) => slot.key)
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    version: row.version,
    curated: row.is_curated,
    modules: { intake, dashboard },
    slot_keys: slotKeys,
  }
}

function extractPlanJson(content: string): unknown {
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
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      // try next candidate
    }
  }
  return null
}

function planIssueSummary(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return handleOptions(request)
  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'POST required' }, 405)
  }

  const session = await readSession(request)
  if (!session) return jsonResponse(request, { error: 'Not authenticated' }, 401)
  if (session.app_role !== 'admin') return jsonResponse(request, { error: 'Admin session required' }, 403)

  try {
    const body = await request.json()
    const workflowId = typeof body?.workflow_id === 'string' ? body.workflow_id : ''
    const clientId = typeof body?.client_id === 'string' ? body.client_id : ''
    const brief = typeof body?.brief === 'string' ? body.brief.trim() : ''
    const transcriptSessionId =
      typeof body?.transcript_session_id === 'string' && body.transcript_session_id.trim().length > 0
        ? body.transcript_session_id.trim().slice(0, 120)
        : null
    if (!UUID_RE.test(workflowId) || !UUID_RE.test(clientId) || brief.length === 0) {
      return jsonResponse(request, { error: 'workflow_id, client_id and brief are required' }, 400)
    }

    // --------------------------------------------------------------
    // Rate guard (durable anchor: spec_drafts rows, source='plan').
    // --------------------------------------------------------------
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const spent = await restCount('spec_drafts', {
      client_id: `eq.${clientId}`,
      source: 'eq.plan',
      created_at: `gte.${hourAgo}`,
    })
    if (spent >= PLAN_MAX_PER_HOUR) {
      return jsonResponse(request, { error: 'Plan limit reached for this hour — try again shortly.' }, 429)
    }

    // --------------------------------------------------------------
    // Context assembly.
    // --------------------------------------------------------------
    const clientRows = await restSelect<{ id: string; name: string }>('clients', {
      id: `eq.${clientId}`,
      select: 'id,name',
      limit: '1',
    })
    if (clientRows.length === 0) return jsonResponse(request, { error: 'Client not found' }, 404)
    const clientName = clientRows[0].name

    const workflowRows = await restSelect<{ id: string; name: string; description: string | null }>('workflows', {
      client_id: `eq.${clientId}`,
      select: 'id,name,description',
      order: 'created_at.asc',
    })
    const existingWorkflows = workflowRows.map((row) => row.name)

    const templateRows = await restSelect<TemplateRow>('workflow_templates', {
      select: 'id,name,description,category,version,spec,slots,is_curated',
      order: 'is_curated.desc,updated_at.desc',
      limit: String(MAX_CANDIDATES),
    })
    const candidates = templateRows.map(candidateSummary)

    // Transcript: explicit session wins; else auto-attach the client's most
    // recent call when it is fresh enough.
    let transcriptLines: string[] = []
    let attachedSession: string | null = transcriptSessionId
    if (attachedSession === null) {
      const recent = await restSelect<{ session_id: string; created_at: string }>('transcript_segments', {
        client_id: `eq.${clientId}`,
        select: 'session_id,created_at',
        order: 'created_at.desc',
        limit: '1',
      })
      if (
        recent.length > 0 &&
        Date.now() - Date.parse(recent[0].created_at) < TRANSCRIPT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
      ) {
        attachedSession = recent[0].session_id
      }
    }
    if (attachedSession !== null) {
      const segments = await restSelect<{ text: string }>('transcript_segments', {
        client_id: `eq.${clientId}`,
        session_id: `eq.${attachedSession}`,
        select: 'text',
        order: 'created_at.desc,id.desc',
        limit: String(MAX_TRANSCRIPT_LINES),
      })
      transcriptLines = segments.map((row) => row.text).reverse()
    }

    // --------------------------------------------------------------
    // One GLM call → WorkflowPlan (self-correction, max 3 rounds).
    // --------------------------------------------------------------
    const instructionRows = await restSelect<{ content: string }>('agent_instructions', {
      key: 'eq.workflow_planner',
      select: 'content',
      limit: '1',
    })
    const systemPrompt = instructionRows[0]?.content ??
      'You are the workflow planner for Connective Sandbox. Return ONE WorkflowPlan JSON object. You never emit a WorkflowSpec.'

    const user = [
      `CLIENT: ${clientName}`,
      existingWorkflows.length > 0
        ? `EXISTING WORKFLOWS (do not duplicate — plan additions or improvements): ${existingWorkflows.join('; ')}`
        : 'EXISTING WORKFLOWS: none — this is their first.',
      `BRIEF:\n"""${brief.slice(0, MAX_BRIEF_CHARS)}"""`,
      transcriptLines.length > 0
        ? `DISCOVERY CALL TRANSCRIPT (oldest → newest):\n${transcriptLines.join('\n').slice(-2500)}`
        : 'DISCOVERY CALL TRANSCRIPT: none available.',
      `TEMPLATE CANDIDATES (id · name · category vVersion · modules · slot keys):\n${JSON.stringify(candidates, null, 1).slice(0, 9000)}`,
      'MODULE MENU (display values only):',
      `intake: ${INTAKE_KINDS.join(', ')}`,
      `dashboard: ${PANEL_KINDS.join(', ')}, decision_log, usage_counter (always-on)`,
      'Reply with ONE JSON object shaped exactly:',
      '{"headline": "...", "rationale": "...", "template_id": "<uuid or null>", "template_name": "<name or null>", "modules": {"intake": ["..."], "dashboard": ["..."]}, "customisations": [{"key": "<slot key>", "value": "<string or number>", "why": "<one line>"}], "open_questions": ["..."]}',
    ].join('\n\n')

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: user },
    ]

    let plan: WorkflowPlan | null = null
    let planError: string | null = null
    const roundMessages = [...messages]
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const content = await glmChat(roundMessages, { maxTokens: 3072, reasoningEffort: planReasoningEffort() })
      const raw = extractPlanJson(content)
      if (raw === null) {
        planError = 'The planner reply contained no JSON plan.'
        break
      }
      const parsed = safeParseWorkflowPlan(raw)
      if (parsed.success) {
        plan = parsed.data
        planError = null
        break
      }
      planError = planIssueSummary(parsed.error)
      console.log(`[plan-workflow] round ${round} plan invalid: ${planError}`)
      roundMessages.push({ role: 'assistant', content })
      roundMessages.push({
        role: 'user',
        content: `Your WorkflowPlan failed validation: ${planError}\n\nReturn the COMPLETE corrected plan as ONE JSON object.`,
      })
    }
    if (plan === null) {
      return jsonResponse(request, { error: planError ?? 'The planner could not produce a valid plan.' }, 502)
    }

    // --------------------------------------------------------------
    // Deterministic compile: chosen template + plan customisations.
    // --------------------------------------------------------------
    let baseSpec: WorkflowSpec | null = null
    let baseSlots: TemplateSlot[] = []
    if (plan.template_id !== null && UUID_RE.test(plan.template_id)) {
      const rows = await restSelect<TemplateRow>('workflow_templates', {
        id: `eq.${plan.template_id}`,
        select: 'id,name,spec,slots',
        limit: '1',
      })
      if (rows.length > 0) {
        baseSpec = rows[0].spec as unknown as WorkflowSpec
        baseSlots = Array.isArray(rows[0].slots) ? (rows[0].slots as TemplateSlot[]) : []
      }
    }
    if (baseSpec === null) {
      // No template matched: compile the generic baseline (never reject).
      const parsed = safeParseWorkflowSpec(compileSpec('generic', new Map<string, FactStateEntry>()))
      if (!parsed.success) return jsonResponse(request, { error: 'Catalogue baseline invalid' }, 500)
      baseSpec = parsed.data
    }

    const values: Record<string, string | number> = {}
    for (const item of plan.customisations) values[item.key] = item.value
    const { spec: compiled, applied } = applySlotValues(baseSpec, baseSlots, values)

    // Identity: the plan's name/description customisations win when present;
    // otherwise the headline names the build.
    if (!('name' in values)) compiled.name = plan.headline.slice(0, 80)
    const validated = safeParseWorkflowSpec(compiled)
    if (!validated.success) {
      const detail = validated.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      return jsonResponse(request, { error: `Compiled plan failed validation — ${detail}` }, 422)
    }

    // --------------------------------------------------------------
    // Persist: draft row (plan attached) + workflow row identity sync.
    // --------------------------------------------------------------
    const versionRows = await restSelect<{ version: number }>('spec_drafts', {
      workflow_id: `eq.${workflowId}`,
      select: 'version',
      order: 'version.desc',
      limit: '1',
    })
    const version = (versionRows[0]?.version ?? 0) + 1
    const inserted = await restInsert<{ id: string }>('spec_drafts', {
      client_id: clientId,
      workflow_id: workflowId,
      session_id: `plan-${Date.now()}`,
      version,
      spec: validated.data,
      delta_summary: plan.headline,
      source: 'plan',
      published: false,
      plan,
    })
    await restUpdate('workflows', { id: `eq.${workflowId}` }, {
      name: validated.data.name,
      description: validated.data.description,
      updated_at: new Date().toISOString(),
    })

    return jsonResponse(request, {
      plan,
      draft: {
        id: inserted[0]?.id ?? null,
        version,
        spec: validated.data,
        delta_summary: plan.headline,
      },
      applied,
    })
  } catch (error) {
    console.error('[plan-workflow] error:', error instanceof Error ? error.message : error)
    return jsonResponse(request, { error: 'Internal error' }, 500)
  }
})
