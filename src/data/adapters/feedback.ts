// Feedback channel adapter (browser-side). All calls ride the `feedback`
// Edge Function gateway (same-origin, session cookie). The client sees only
// their own thread; the rep sees all threads through the admin Inbox. The AI
// never sends client-facing text — rep replies are human messages.

import { assertOk, callFunction } from '@/data/api'
import type { WorkflowSpec } from '@/engine/types'

export type FeedbackClassification =
  | 'wording'
  | 'structure'
  | 'accuracy'
  | 'feature_request'
  | 'bug'
  | 'question'

export interface FeedbackAttachment {
  artifact_id: string
  filename: string
}

export interface FeedbackMessage {
  id: string
  client_id: string
  workflow_id: string | null
  direction: 'client' | 'rep'
  body: string
  attachments: FeedbackAttachment[]
  classification: FeedbackClassification | null
  confidence: number | null
  referenced_judge: string | null
  classification_fallback: boolean
  read_by_rep: boolean
  read_by_client: boolean
  created_at: string
}

export interface FeedbackThread {
  client_id: string
  client_name: string
  last_message: string
  last_at: string
  last_direction: string
  unread: number
  latest_classification: FeedbackClassification | null
}

export interface FeedbackDraft {
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

export interface SendFeedbackResult {
  message: FeedbackMessage
  classification: FeedbackClassification
  confidence: number
  classification_fallback: boolean
  referenced_judge?: string | null
  /** A change was detected but the hourly planner budget held the draft back. */
  planner_suppressed?: boolean
  draft?: { id: string; version: number; delta_summary: string }
  draft_error?: string
}

/** Send one client feedback message (stored, classified, maybe drafted). */
export async function sendFeedback(payload: {
  body: string
  workflow_id?: string | null
  attachments?: FeedbackAttachment[]
}): Promise<SendFeedbackResult> {
  const response = await callFunction<SendFeedbackResult & { error?: string }>('/feedback', {
    method: 'POST',
    body: payload,
  })
  assertOk(response as unknown as FunctionResponsePlain)
  return response.data
}

/** Rep reply in-thread (admin session; the client-facing human voice). */
export async function sendRepReply(clientId: string, body: string): Promise<FeedbackMessage> {
  const response = await callFunction<{ message?: FeedbackMessage; error?: string }>('/feedback', {
    method: 'POST',
    body: { client_id: clientId, body },
  })
  assertOk(response as unknown as FunctionResponsePlain)
  if (!response.data.message) throw new Error('Reply could not be stored')
  return response.data.message
}

/** Client: load own thread (marks the rep's replies read). */
export async function getMyFeedback(): Promise<FeedbackMessage[]> {
  const response = await callFunction<{ messages?: FeedbackMessageRow[] }>('/feedback')
  if (response.status >= 400) return []
  return (response.data.messages ?? []).map(rowToMessage)
}

/** Admin: load one thread + proposed drafts (marks the thread read). */
export async function getAdminThread(
  clientId: string,
): Promise<{ messages: FeedbackMessage[]; drafts: FeedbackDraft[] }> {
  const response = await callFunction<{
    messages?: FeedbackMessageRow[]
    drafts?: FeedbackDraftRow[]
    error?: string
  }>(`/feedback?client_id=${encodeURIComponent(clientId)}`)
  assertOk(response as unknown as FunctionResponsePlain)
  return {
    messages: (response.data.messages ?? []).map(rowToMessage),
    drafts: (response.data.drafts ?? []).map(draftRowToDraft),
  }
}

/** Admin: thread list with unread counts (quiet badges only). */
export async function listFeedbackThreads(): Promise<FeedbackThread[]> {
  const response = await callFunction<{ threads?: FeedbackThread[]; error?: string }>(
    '/feedback?threads=1',
  )
  if (response.status >= 400) return []
  return response.data.threads ?? []
}

interface FunctionResponsePlain {
  status: number
  data: { error?: string }
}

interface FeedbackMessageRow extends Omit<FeedbackMessage, 'attachments'> {
  attachments: unknown
}

function rowToMessage(row: FeedbackMessageRow): FeedbackMessage {
  return {
    ...row,
    attachments: Array.isArray(row.attachments)
    ? (row.attachments as FeedbackAttachment[])
      : [],
  }
}

interface FeedbackDraftRow extends Omit<FeedbackDraft, 'spec'> {
  spec: unknown
}

function draftRowToDraft(row: FeedbackDraftRow): FeedbackDraft {
  return { ...row, spec: row.spec as FeedbackDraft['spec'] }
}
