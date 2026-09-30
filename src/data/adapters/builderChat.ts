// Live builder chat (Phase 6). The workflow-builder LLM runs in the
// admin-chat Edge Function: system prompt loads at request time from
// agent_instructions, emitted specs are validated against the frozen Zod
// schema server-side (with model self-correction), and the conversation
// persists per client+workflow as real sessions/messages rows.
//
// The original adapter signatures are kept: history keyed by
// `${clientId}:${workflowId}`, BuilderChatMessage shape.

import type { WorkflowSpec } from '@/engine/types'
import { callFunction, streamFunction } from '@/data/api'

export interface BuilderChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Wall-clock timestamp for the WhatsApp-style transcript. */
  at?: string
  /** Raw spec payload attached to assistant messages that propose a workflow. */
  spec?: WorkflowSpec
}

interface SessionRow {
  id: string
  workflow_id: string
  kind: string
}

interface MessageRow {
  id: string
  role: string
  content: string
  created_at: string
}

export function builderGreeting(): BuilderChatMessage {
  return {
    id: `bc_greeting_${Date.now()}`,
    role: 'assistant',
    content: 'Describe the workflow you need. I will draft a spec you can load into the preview.',
    at: new Date().toISOString(),
  }
}

function workflowIdFromKey(key: string): string {
  const index = key.indexOf(':')
  return index === -1 ? key : key.slice(index + 1)
}

async function findBuilderSession(workflowId: string): Promise<string | null> {
  const { status, data } = await callFunction<{ sessions?: SessionRow[] }>(
    `/admin-api/sessions?workflow_id=${encodeURIComponent(workflowId)}&kind=builder`,
  )
  if (status >= 400) return null
  return data.sessions?.[0]?.id ?? null
}

export async function getBuilderHistory(key: string): Promise<BuilderChatMessage[]> {
  const workflowId = workflowIdFromKey(key)
  if (!/^[0-9a-f-]{36}$/i.test(workflowId)) return [builderGreeting()]
  const sessionId = await findBuilderSession(workflowId)
  if (sessionId === null) return [builderGreeting()]
  const { status, data } = await callFunction<{ messages?: MessageRow[] }>(
    `/admin-api/sessions/${sessionId}/messages`,
  )
  if (status >= 400) return [builderGreeting()]
  const rows = (data.messages ?? []).filter(
    (row) => row.role === 'user' || row.role === 'assistant',
  )
  if (rows.length === 0) return [builderGreeting()]
  return rows.map((row) => ({
    id: row.id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    at: row.created_at,
  }))
}

export interface BuilderSendResult {
  content: string
  /** The validated spec, when the reply contained one. */
  spec: WorkflowSpec | null
  /** Why the emitted spec failed validation, when it could not be corrected. */
  validationError: string | null
}

/** Stream one builder turn through the admin-chat gateway. */
export async function sendBuilderMessage(
  workflowId: string,
  content: string,
  onDelta: (delta: string) => void,
): Promise<BuilderSendResult> {
  let full = ''
  const { done } = await streamFunction(
    '/admin-chat',
    { workflow_id: workflowId, message: content },
    (delta) => {
      full += delta
      onDelta(delta)
    },
  )
  const spec = (done?.spec ?? null) as WorkflowSpec | null
  return {
    content: full,
    spec: spec !== null && typeof spec === 'object' ? spec : null,
    validationError: typeof done?.validation_error === 'string' ? done.validation_error : null,
  }
}
