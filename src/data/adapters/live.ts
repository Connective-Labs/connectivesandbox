// Live transcription pipeline adapter (browser-side). All calls ride the
// `live-draft` Edge Function gateway (admin JWT cookie, same-origin). The
// browser never touches PostgREST and never sees screening/drafting
// credentials — segments are text only, no audio ever leaves the client.

import type { WorkflowSpec } from '@/engine/types'
import { assertOk, callFunction, type FunctionResponse } from '@/data/api'

export type DraftSource = 'transcript' | 'manual' | 'chat'

export interface SpecDraft {
  id: string
  client_id: string
  workflow_id: string | null
  version: number
  spec: WorkflowSpec
  delta_summary: string
  source: DraftSource
  published: boolean
  created_at: string
}

export interface LiveDraftSegment {
  segment_index?: number
  text: string
}

export interface ScreenAndDraftResult {
  changed: boolean
  delta_summary: string
  screen_choice?: string
  screen_confidence?: number
  draft_spec?: WorkflowSpec
  draft_version?: number
  draft_id?: string | null
  /** A change was detected but the rate guard held the draft back. */
  draft_suppressed?: boolean
  /** The regenerated spec failed schema validation even after self-correction. */
  draft_error?: string
  error?: string
}

/** Send newly transcribed segments for screening + (maybe) draft generation. */
export async function screenAndDraft(payload: {
  client_id: string
  workflow_id: string | null
  session_id: string
  transcript_digest: string
  new_segments: LiveDraftSegment[]
  current_spec: WorkflowSpec | null
}): Promise<ScreenAndDraftResult> {
  const response = await callFunction<ScreenAndDraftResult>('/live-draft', {
    method: 'POST',
    body: payload,
  })
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data
}

/** Draft rail for a workflow, newest version first. */
export async function listSpecDrafts(workflowId: string): Promise<SpecDraft[]> {
  const response = await callFunction<{ drafts?: SpecDraft[] }>(
    `/live-draft?workflow_id=${encodeURIComponent(workflowId)}`,
  )
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return (response.data.drafts ?? []).map((draft) => ({
    ...draft,
    source: (draft.source ?? 'transcript') as DraftSource,
  }))
}

/** Discard a draft (one click, with confirm, in the draft rail). */
export async function discardDraft(draftId: string): Promise<void> {
  assertOk(
    await callFunction(`/live-draft?draft_id=${encodeURIComponent(draftId)}`, { method: 'DELETE' }),
  )
}

/** Flip the published flag after the existing publish path succeeds. */
export async function markDraftPublished(draftId: string, published: boolean): Promise<void> {
  assertOk(
    await callFunction('/live-draft', {
      method: 'PATCH',
      body: { draft_id: draftId, published },
    }),
  )
}
