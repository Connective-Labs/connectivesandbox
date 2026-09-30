// admin-chat — GLM-5.3-Flash workflow builder for the admin console.
//
//   POST /admin-chat   { workflow_id: uuid, message: string }
//
// - Verifies the admin JWT cookie before anything.
// - Loads the system prompt at request time from `agent_instructions`
//   where key = 'workflow_builder'.
// - Conversation history persists per client+workflow as real rows: one
//   sessions row with kind='builder' per workflow, messages under it.
// - Any WorkflowSpec JSON the model emits is validated against the frozen
//   Zod schema (src/engine/schema.ts) BEFORE it is returned; validation
//   errors are fed back to the model so it can self-correct (max 3 rounds).
// - The final reply is streamed to the browser as SSE events:
//     data: {"delta": "..."}              (content chunks)
//     data: {"done":true, ...}            (final metadata)
//     data: [DONE]
// - If no spec could be parsed, done carries spec: null and the validation
//   error so the UI can surface it.

import { handleOptions } from '../_shared/cors.ts'
import { readSession } from '../_shared/jwt.ts'
import { restInsert, restSelect } from '../_shared/rest.ts'
import { glmChat, type GlmMessage } from '../_shared/glm.ts'
import { extractSpecJson, validateSpec } from '../_shared/spec-validate.ts'

import type { WorkflowSpec } from '../../../src/engine/types.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HISTORY_LIMIT = 24
const MAX_ROUNDS = 3

interface MessageRow {
  id: string
  role: string
  content: string
  created_at: string
}

function sseChunk(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return handleOptions(request)
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405 })
  }

  // Auth first: admin JWT cookie.
  const session = await readSession(request)
  if (!session) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (session.app_role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin session required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let body: { workflow_id?: string; message?: string }
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 })
  }
  const workflowId = body.workflow_id ?? ''
  const message = (body.message ?? '').trim()
  if (!UUID_RE.test(workflowId) || message.length === 0) {
    return new Response(JSON.stringify({ error: 'workflow_id and message are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // The workflow identifies the client whose builder chat this is.
    const workflows = await restSelect<{ id: string; client_id: string; name: string }>('workflows', {
      id: `eq.${workflowId}`,
      select: 'id,client_id,name',
      limit: '1',
    })
    const workflow = workflows[0]
    if (!workflow) {
      return new Response(JSON.stringify({ error: 'Workflow not found' }), { status: 404 })
    }

    // Builder conversation: one sessions row (kind='builder') per workflow.
    let builderSessions = await restSelect<{ id: string }>('sessions', {
      workflow_id: `eq.${workflowId}`,
      kind: 'eq.builder',
      select: 'id',
      limit: '1',
    })
    if (builderSessions.length === 0) {
      builderSessions = await restInsert<{ id: string }>('sessions', {
        workflow_id: workflowId,
        client_id: workflow.client_id,
        kind: 'builder',
      })
    }
    const builderSessionId = builderSessions[0]?.id
    if (!builderSessionId) {
      return new Response(JSON.stringify({ error: 'Could not resolve builder session' }), { status: 500 })
    }

    // Persist the user message, then load the conversation window.
    // PostgREST applies `limit` AFTER `order`, so ascending order would
    // return the OLDEST rows and hide the rep's newest turn entirely —
    // fetch the newest window descending, then restore chronological order.
    await restInsert('messages', { session_id: builderSessionId, role: 'user', content: message })
    const newestFirst = await restSelect<MessageRow>('messages', {
      session_id: `eq.${builderSessionId}`,
      select: 'id,role,content,created_at',
      order: 'created_at.desc,id.desc',
      limit: String(HISTORY_LIMIT),
    })
    const history = newestFirst.reverse()

    // System prompt loads at request time from agent_instructions.
    const instructions = await restSelect<{ content: string }>('agent_instructions', {
      key: 'eq.workflow_builder',
      select: 'content',
      limit: '1',
    })
    const systemPrompt = instructions[0]?.content ??
      'You are the workflow builder for Connective Sandbox. Emit a single WorkflowSpec JSON object when asked.'

    const conversation: GlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history
        .filter((row) => row.role === 'user' || row.role === 'assistant')
        .map<GlmMessage>((row) => ({ role: row.role as 'user' | 'assistant', content: row.content })),
    ]

    // Self-correction loop: emit → validate against the Zod schema → feed
    // errors back. The spec is only "returned" once it validates (or rounds
    // are exhausted, with the error surfaced to the UI — never a silent pass).
    let content = ''
    let validated: WorkflowSpec | null = null
    let validationError: string | null = null
    const roundMessages = [...conversation]
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      content = await glmChat(roundMessages)
      const specJson = extractSpecJson(content)
      if (specJson === null) {
        // No spec emitted — a plain prose turn is fine; nothing to validate.
        validationError = null
        break
      }
      const result = validateSpec(specJson)
      if (result.ok) {
        validated = result.spec
        validationError = null
        break
      }
      validationError = result.error
      console.log(`[admin-chat] round ${round} spec invalid: ${result.error}`)
      roundMessages.push({ role: 'assistant', content })
      roundMessages.push({
        role: 'user',
        content:
          `Your WorkflowSpec block failed schema validation: ${result.error}\n\n` +
          'Fix the issues and re-emit the COMPLETE WorkflowSpec JSON in one ```json block.',
      })
    }

    // Persist the assistant reply.
    await restInsert('messages', { session_id: builderSessionId, role: 'assistant', content })

    // Stream the final reply to the browser as SSE.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const CHUNK = 96
        for (let index = 0; index < content.length; index += CHUNK) {
          controller.enqueue(sseChunk({ delta: content.slice(index, index + CHUNK) }))
        }
        controller.enqueue(sseChunk({
          done: true,
          session_id: builderSessionId,
          spec: validated,
          validation_error: validationError,
        }))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    console.error('[admin-chat] error:', error instanceof Error ? error.message : error)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 })
  }
})
