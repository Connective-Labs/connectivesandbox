// Live transcription pipeline adapter (browser-side). All calls ride the
// same-origin gateway (admin JWT cookie): `/live-facts` is the fact-ledger
// brain (two-stage jev screen → keyed fact extraction → compiled drafts);
// `/live-draft` keeps the draft-rail operations. The browser never touches
// PostgREST and never sees screening/drafting credentials — segments and
// facts are text only, no audio ever leaves the client.

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

// ---------------------------------------------------------------------------
// Fact ledger (livebuild v2)
// ---------------------------------------------------------------------------

export type FactOp = 'add' | 'update' | 'confirm' | 'remove'
export type FactArea = 'intake' | 'judges' | 'dashboard'

/** One replayed ledger entry (the state view returned by /live-facts). */
export interface FactLedgerEntryView {
  key: string
  op: FactOp
  area: FactArea
  active: boolean
  detail: { strings?: Record<string, string>; meta?: Record<string, unknown> }
  ops: number
}

export interface LiveFactAppend {
  key: string
  op: FactOp
  area: FactArea
}

export interface LiveFactsDraft {
  id: string | null
  version: number
  spec: WorkflowSpec
  delta_summary: string
  /** Polish 6 render-first: true when catalogue placeholders remain and the
   *  parallel fill_strings pass should be requested. */
  strings_pending?: boolean
}

export interface LiveFactsResult {
  /** The ledger signature changed (facts appended or a flush compile ran). */
  changed: boolean
  screen?: 'material_change' | 'no_change'
  screen_confidence?: number
  /** Stage-1 held back by the ~5s screen cadence — resend the same words. */
  screen_suppressed?: boolean
  /** Stage-2 held back by the ~8s extraction cadence — resend the segments. */
  facts_suppressed?: boolean
  appended?: LiveFactAppend[]
  ledger?: FactLedgerEntryView[]
  signature?: string
  fact_cap_reached?: boolean
  draft?: LiveFactsDraft
  draft_suppressed?: boolean
  error?: string
}

export interface SendLiveFactsPayload {
  client_id: string
  workflow_id: string | null
  session_id: string
  recipe_id?: string
  /** Final segments since the last post. */
  new_segments?: LiveDraftSegment[]
  /** Interim words still being spoken (rolling tail; never persisted). */
  rolling_tail?: string
  /** Rolling digest of the call so far (oldest → newest, capped client-side). */
  transcript_digest?: string
  /** Flush mode: compile the current ledger when it drifted from this
   *  signature (no jev spend; the ~4s draft floor holds). */
  compile_signature?: string
}

/** Send new transcript words through the fact-ledger pipeline. */
export async function sendLiveFacts(payload: SendLiveFactsPayload): Promise<LiveFactsResult> {
  const response = await callFunction<LiveFactsResult>('/live-facts', {
    method: 'POST',
    body: payload,
  })
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data
}

// ---------------------------------------------------------------------------
// Parallel string pass (polish 6 — render-first)
// ---------------------------------------------------------------------------

export interface FillStringsResult {
  filled?: string[]
  throttled?: boolean
  draft?: LiveFactsDraft
}

/**
 * Ask the server to run the GLM string pass for placeholder slots. The
 * skeleton draft is already on screen; the returned spec carries the landed
 * strings, which the preview fades in place by element id. The workflow_id
 * MUST ride along so the server recompiles with the SAME recipe context the
 * drafts were compiled under — without it the recompile falls back to the
 * generic baseline and drops every recipe-seeded element.
 */
export async function fillLiveStrings(
  clientId: string,
  sessionId: string,
  workflowId: string | null,
): Promise<FillStringsResult> {
  const response = await callFunction<FillStringsResult>('/live-facts', {
    method: 'POST',
    body: {
      client_id: clientId,
      session_id: sessionId,
      ...(workflowId !== null ? { workflow_id: workflowId } : {}),
      fill_strings: true,
    },
  })
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data
}

// ---------------------------------------------------------------------------
// Draft rail (/live-draft)
// ---------------------------------------------------------------------------

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
