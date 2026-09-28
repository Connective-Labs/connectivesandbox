// Live build mode (live transcription pipeline): record a discovery call,
// watch the rolling captions, and let screened spec drafts accumulate in a
// numbered rail while the conversation is still ongoing. The rep is the UAT
// gate — nothing reaches a client until Publish (the existing action on the
// currently previewed draft) is pressed. Recording + confirming are the only
// required actions; the rep never prompts.

import { useEffect, useRef, useState } from 'react'
import { Disc, Mic, Square, X } from 'lucide-react'

import { Badge, Eyebrow } from '@/components/ui/Primitives'
import { cn } from '@/lib/utils'
import type { WorkflowSpec } from '@/engine/types'
import {
  createWebSpeechEngine,
  speechSupported,
  type TranscriptSegment,
  type TranscriptionEngine,
} from '@/data/adapters/transcribe'
import {
  discardDraft,
  listSpecDrafts,
  markDraftPublished,
  screenAndDraft,
  type SpecDraft,
} from '@/data/adapters/live'

/** Send segments for screening a few seconds after the last sentence lands. */
const SEND_DEBOUNCE_MS = 4000
const MAX_CAPTIONS = 200

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

interface LiveBuildProps {
  clientId: string | null
  workflowId: string | null
  /** The workflow's stored spec — the diff baseline for regeneration. */
  storedSpec: WorkflowSpec | null
  /** Load a draft spec into the existing live preview (right column). */
  onLoadSpec: (spec: WorkflowSpec) => void
  /** Tell the parent which draft Publish should flag as published. */
  onActiveDraftChange: (draft: SpecDraft | null) => void
}

export function LiveBuild({
  clientId,
  workflowId,
  storedSpec,
  onLoadSpec,
  onActiveDraftChange,
}: LiveBuildProps) {
  const [captions, setCaptions] = useState<TranscriptSegment[]>([])
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [drafts, setDrafts] = useState<SpecDraft[]>([])
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [confirmingDiscardId, setConfirmingDiscardId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)

  const engineRef = useRef<TranscriptionEngine | null>(null)
  const supported = useRef(speechSupported()).current
  const sessionIdRef = useRef<string>('')
  const digestRef = useRef('')
  const pendingRef = useRef<TranscriptSegment[]>([])
  const timerRef = useRef<number | null>(null)
  const sendingRef = useRef(false)
  const storedSpecRef = useRef(storedSpec)
  const captionsRef = useRef<HTMLDivElement | null>(null)
  const segmentCounter = useRef(0)

  storedSpecRef.current = storedSpec

  // A new workflow/client selection resets the whole live session.
  useEffect(() => {
    engineRef.current?.stop()
    engineRef.current = null
    setCaptions([])
    setRecording(false)
    setElapsed(0)
    setNotice(null)
    digestRef.current = ''
    pendingRef.current = []
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    sessionIdRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? `call-${crypto.randomUUID()}`
        : `call-${Date.now()}`
    segmentCounter.current = 0
    setActiveDraftId(null)
    onActiveDraftChange(null)
    if (workflowId !== null) {
      void listSpecDrafts(workflowId).then((rows) => {
        setDrafts(rows)
        setActiveDraftId(rows[0]?.id ?? null)
      })
    } else {
      setDrafts([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId])

  // Publish in the parent flips the flag on the active draft.
  useEffect(() => {
    onActiveDraftChange(drafts.find((draft) => draft.id === activeDraftId) ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, activeDraftId])

  const sendPending = async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    if (
      pending.length === 0 || sendingRef.current || clientId === null || workflowId === null ||
      !supported
    ) return
    pendingRef.current = []
    sendingRef.current = true
    setDrafting(true)
    try {
      const result = await screenAndDraft({
        client_id: clientId,
        workflow_id: workflowId,
        session_id: sessionIdRef.current,
        transcript_digest: digestRef.current,
        new_segments: pending.map((segment) => ({
          segment_index: segment.index,
          text: segment.text,
        })),
        current_spec: storedSpecRef.current,
      })
      if (result.error !== undefined) {
        setNotice(`Screening unavailable: ${result.error}`)
      } else if (result.changed && result.draft_spec !== undefined && result.draft_version !== undefined) {
        const draft: SpecDraft = {
          id: result.draft_id ?? `local-${result.draft_version}`,
          client_id: clientId,
          workflow_id: workflowId,
          version: result.draft_version,
          spec: result.draft_spec,
          delta_summary: result.delta_summary,
          source: 'transcript',
          published: false,
          created_at: new Date().toISOString(),
        }
        setDrafts((previous) => [draft, ...previous.filter((row) => row.id !== draft.id)])
        setActiveDraftId(draft.id)
        onLoadSpec(draft.spec)
        setNotice(`Draft v${draft.version} ready — ${draft.delta_summary}`)
      } else if (result.changed && result.draft_suppressed === true) {
        setNotice('Change noted — next draft after the cooldown.')
      } else if (result.changed && result.draft_error !== undefined) {
        setNotice(`Draft rejected: ${result.draft_error}`)
      }
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      sendingRef.current = false
      setDrafting(false)
    }
  }

  const handleSegment = (segment: TranscriptSegment) => {
    setCaptions((previous) => {
      const next = [...previous]
      if (segment.final) {
        next.push(segment)
        if (next.length > MAX_CAPTIONS) next.splice(0, next.length - MAX_CAPTIONS)
      } else {
        const last = next[next.length - 1]
        if (last !== undefined && !last.final) next[next.length - 1] = segment
        else next.push(segment)
      }
      return next
    })
    if (!segment.final) return
    digestRef.current += `${segment.text}\n`
    pendingRef.current.push(segment)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => void sendPending(), SEND_DEBOUNCE_MS)
  }

  const startRecording = () => {
    if (!supported || clientId === null || workflowId === null) return
    setNotice(null)
    engineRef.current = createWebSpeechEngine({
      onSegment: handleSegment,
      onError: (message) => setNotice(message),
    })
    engineRef.current.start()
    setRecording(true)
  }

  const stopRecording = () => {
    engineRef.current?.stop()
    engineRef.current = null
    setRecording(false)
    void sendPending()
  }

  // Elapsed time ticks only while recording.
  useEffect(() => {
    if (!recording) return
    const startedAt = Date.now() - elapsed * 1000
    const interval = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  // Captions stay pinned to the newest line while the call runs.
  useEffect(() => {
    const pane = captionsRef.current
    if (pane !== null) pane.scrollTop = pane.scrollHeight
  }, [captions])

  const confirmDiscard = async (draftId: string) => {
    setConfirmingDiscardId(null)
    try {
      await discardDraft(draftId)
      setDrafts((previous) => previous.filter((draft) => draft.id !== draftId))
      setActiveDraftId((current) => (current === draftId ? null : current))
      setNotice('Draft discarded.')
    } catch (error) {
      setNotice((error as Error).message)
    }
  }

  if (clientId === null || workflowId === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-sm text-slate-400">Select a client and workflow to build live.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Record control + live state */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {recording ? (
            <>
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              </span>
              <span className="font-mono text-sm font-semibold text-ink">{formatElapsed(elapsed)}</span>
              <span className="text-xs text-slate-400">recording</span>
            </>
          ) : (
            <Eyebrow>Live build</Eyebrow>
          )}
          {drafting && (
            <Badge tone="neutral">
              <span className="animate-pulse">drafting…</span>
            </Badge>
          )}
        </div>
        {!supported ? (
          <p className="text-xs font-medium text-slate-500">Live transcription needs Chrome.</p>
        ) : recording ? (
          <button
            type="button"
            onClick={stopRecording}
            className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700"
          >
            <Square size={12} aria-hidden="true" /> Stop recording
          </button>
        ) : (
          <button
            type="button"
            onClick={startRecording}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover active:bg-accent-pressed"
          >
            <Mic size={14} aria-hidden="true" /> Start recording
          </button>
        )}
      </div>

      {notice !== null && (
        <p role="status" className="shrink-0 px-5 py-2 text-xs font-medium text-accent">
          {notice}
        </p>
      )}

      {/* Live captions pane */}
      <div
        ref={captionsRef}
        className="scroll-slim mx-5 my-3 min-h-0 flex-1 overflow-y-auto rounded-xl bg-slate-50 px-4 py-3"
        aria-label="Live captions"
      >
        {captions.length === 0 ? (
          <p className="text-xs text-slate-400">
            {supported
              ? 'Press Start recording — the transcript and numbered spec drafts appear here while you talk.'
              : 'Live transcription needs Chrome.'}
          </p>
        ) : (
          <ol className="space-y-1.5 font-mono text-xs leading-relaxed text-slate-600">
            {captions.map((segment, index) => (
              <li
                key={`${segment.index}-${index}`}
                className={cn('break-words [overflow-wrap:anywhere]', !segment.final && 'text-slate-400 italic')}
              >
                <span className="mr-2 select-none text-slate-300">
                  {new Date(segment.at).toLocaleTimeString('en-SG', { hour12: false })}
                </span>
                {segment.text}
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Draft rail */}
      <div className="shrink-0 border-t border-slate-200 px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <Eyebrow>Spec drafts</Eyebrow>
          {drafts.length > 0 && <span className="text-xs text-slate-400">{drafts.length} total</span>}
        </div>
        {drafts.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Numbered drafts appear here as the screener detects changes. Publish stays on the right.
          </p>
        ) : (
          <ul className="scroll-slim mt-2 max-h-36 space-y-1 overflow-y-auto pr-1">
            {drafts.map((draft) => (
              <li
                key={draft.id}
                className={cn(
                  'group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors',
                  draft.id === activeDraftId
                    ? 'border-accent bg-accent-wash'
                    : 'border-slate-200 bg-white hover:border-accent',
                )}
              >
                {confirmingDiscardId === draft.id ? (
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span className="truncate text-xs text-slate-600">Discard v{draft.version}?</span>
                    <span className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => void confirmDiscard(draft.id)}
                        className="rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold text-white transition hover:bg-red-700"
                      >
                        Discard
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingDiscardId(null)}
                        className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-600 transition hover:border-accent hover:text-accent"
                      >
                        Cancel
                      </button>
                    </span>
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveDraftId(draft.id)
                        onLoadSpec(draft.spec)
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={`Load draft v${draft.version} into the preview`}
                    >
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 font-mono text-xs font-semibold',
                          draft.id === activeDraftId
                            ? 'bg-accent text-white'
                            : 'bg-slate-100 text-slate-600',
                        )}
                      >
                        v{draft.version}
                      </span>
                      <span className="truncate text-xs text-slate-600">{draft.delta_summary}</span>
                      {draft.published && (
                        <span className="shrink-0 text-xs font-semibold text-emerald-700">published</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDiscardId(draft.id)}
                      aria-label={`Discard draft v${draft.version}`}
                      className="shrink-0 rounded-full p-1 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-slate-100 hover:text-red-600 focus:opacity-100"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
          <Disc size={12} aria-hidden="true" />
          Publish sends the previewed draft to the client — you are the gate.
        </p>
      </div>
    </div>
  )
}

export { markDraftPublished }
