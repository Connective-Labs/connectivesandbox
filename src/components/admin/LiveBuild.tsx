// Live build mode (livebuild v2 — fact-ledger architecture). Record a
// discovery call; the two-stage jev pipeline screens the ROLLING transcript
// every ~5 seconds (captain decision: rolling, not sentence-end) and, on a
// material change, extracts keyed facts; the spec is a compiled projection of
// the fact ledger, so repeated statements can never duplicate modules. The
// rep is the UAT gate — nothing reaches a client until Publish (the existing
// action on the currently previewed draft) is pressed.
//
// Rendering: ONE continuously-growing transcript — words appear in place with
// a subtle fade (word-level), settled sentences solidify; no half-sentence
// juggling, no stop-only flush. The preview shows only the delta animating in
// (framer-motion mount animations keyed by element id in Chat/DashboardPane;
// compiled specs are byte-stable for unchanged state, so nothing re-mounts
// wholesale).
//
// Engines (transparent to this UI via TranscriptionEngine): the server engine
// (MediaRecorder → /live-transcribe → Deepgram, all browsers) is the default
// when its secret is provisioned; the Web Speech engine is the fallback. No
// audio is stored anywhere — only final text segments persist.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Disc, Mic, Square, X } from 'lucide-react'

import { Badge, Eyebrow } from '@/components/ui/Primitives'
import { cn } from '@/lib/utils'
import type { WorkflowSpec } from '@/engine/types'
import {
  chooseEngine,
  createEngine,
  recordingSupported,
  speechSupported,
  type EngineChoice,
  type TranscriptSegment,
  type TranscriptionEngine,
} from '@/data/adapters/transcribe'
import {
  discardDraft,
  listSpecDrafts,
  markDraftPublished,
  sendLiveFacts,
  type FactLedgerEntryView,
  type SpecDraft,
} from '@/data/adapters/live'

/** Rolling screen cadence — jev reads the transcript every ~5 seconds. */
const SCREEN_TICK_MS = 5000
/** Draft compile floor (~10s) honoured client-side before a flush compile. */
const FLUSH_DELAY_MS = 10_000
const MAX_CAPTIONS = 200
const FACT_AREA_STYLES: Record<string, string> = {
  intake: 'bg-sky-50 text-sky-700 border-sky-200',
  judges: 'bg-violet-50 text-violet-700 border-violet-200',
  dashboard: 'bg-amber-50 text-amber-700 border-amber-200',
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

interface LiveBuildProps {
  clientId: string | null
  workflowId: string | null
  /** The workflow's stored spec — the diff baseline for compiled drafts. */
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
  const [facts, setFacts] = useState<FactLedgerEntryView[]>([])
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [drafts, setDrafts] = useState<SpecDraft[]>([])
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [confirmingDiscardId, setConfirmingDiscardId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [screening, setScreening] = useState(false)
  const [engineChoice, setEngineChoice] = useState<EngineChoice | null>(null)

  const engineRef = useRef<TranscriptionEngine | null>(null)
  const engineTagRef = useRef<EngineChoice>('server')
  const canRecord = useRef(recordingSupported() || speechSupported()).current
  const sessionIdRef = useRef<string>('')
  const digestRef = useRef('')
  const pendingRef = useRef<TranscriptSegment[]>([])
  const tailRef = useRef('')
  const signatureRef = useRef<string | null>(null)
  const flushSignatureRef = useRef<string | null>(null)
  const flushTimerRef = useRef<number | null>(null)
  const postStopTimersRef = useRef<number[]>([])
  const recordingGenerationRef = useRef(0)
  const sendingRef = useRef(false)
  const storedSpecRef = useRef(storedSpec)
  const captionsRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef({ clientId, workflowId })
  stateRef.current = { clientId, workflowId }

  storedSpecRef.current = storedSpec

  // A new workflow/client selection resets the whole live session.
  useEffect(() => {
    engineRef.current?.stop()
    engineRef.current = null
    setCaptions([])
    setFacts([])
    setRecording(false)
    setElapsed(0)
    setNotice(null)
    digestRef.current = ''
    pendingRef.current = []
    tailRef.current = ''
    signatureRef.current = null
    flushSignatureRef.current = null
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current)
    flushTimerRef.current = null
    for (const timer of postStopTimersRef.current) window.clearTimeout(timer)
    postStopTimersRef.current = []
    sessionIdRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? `call-${crypto.randomUUID()}`
        : `call-${Date.now()}`
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

  // Engine choice is probed once per mount: the server engine (all browsers)
  // when its secret is provisioned, Web Speech as the fallback.
  useEffect(() => {
    void chooseEngine().then((choice) => setEngineChoice(choice))
  }, [])

  // Publish in the parent flips the flag on the active draft.
  useEffect(() => {
    onActiveDraftChange(drafts.find((draft) => draft.id === activeDraftId) ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, activeDraftId])

  const acceptDraft = (
    draft: { id: string | null; version: number; spec: WorkflowSpec; delta_summary: string } | undefined,
    clientIdValue: string,
  ) => {
    if (draft === undefined) return
    const row: SpecDraft = {
      id: draft.id ?? `local-${draft.version}`,
      client_id: clientIdValue,
      workflow_id: stateRef.current.workflowId ?? '',
      version: draft.version,
      spec: draft.spec,
      delta_summary: draft.delta_summary,
      source: 'transcript',
      published: false,
      created_at: new Date().toISOString(),
    }
    setDrafts((previous) => [row, ...previous.filter((existing) => existing.id !== row.id)])
    setActiveDraftId(row.id)
    onLoadSpec(row.spec)
    setNotice(`Draft v${row.version} — ${row.delta_summary}`)
  }

  const scheduleFlush = (signature: string) => {
    flushSignatureRef.current = signature
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current)
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      void sendTick()
    }, FLUSH_DELAY_MS)
  }

  const sendTick = async () => {
    if (sendingRef.current) return
    const { clientId: clientIdValue, workflowId: workflowIdValue } = stateRef.current
    if (clientIdValue === null || workflowIdValue === null) return
    const pending = pendingRef.current
    const tail = tailRef.current
    const flushSignature = flushSignatureRef.current
    const hasWords = pending.length > 0 || tail.length > 0
    if (!hasWords && flushSignature === null) return
    sendingRef.current = true
    setScreening(true)
    try {
      const result = await sendLiveFacts(
        hasWords
          ? {
              client_id: clientIdValue,
              workflow_id: workflowIdValue,
              session_id: sessionIdRef.current,
              new_segments: pending.map((segment) => ({
                segment_index: segment.index,
                text: segment.text,
              })),
              rolling_tail: tail,
              transcript_digest: digestRef.current,
            }
          : {
              client_id: clientIdValue,
              workflow_id: workflowIdValue,
              session_id: sessionIdRef.current,
              compile_signature: flushSignature ?? '',
            },
      )
      if (result.error !== undefined) {
        // Words stay queued; the next tick retries. A rejected draft is a
        // pipeline bug, never a user-visible error — drafts always arrive.
        setNotice(`Fact screening unavailable — retrying: ${result.error}`)
        return
      }
      if (result.screen_suppressed === true || result.facts_suppressed === true) {
        // Keep the words queued; the next rolling tick retries.
        if (result.signature !== undefined) signatureRef.current = result.signature
        return
      }
      flushSignatureRef.current = null
      if (hasWords) pendingRef.current = []
      if (result.signature !== undefined) signatureRef.current = result.signature
      if (result.ledger !== undefined) {
        setFacts(result.ledger.filter((entry) => entry.active))
      }
      if (result.changed && result.draft !== undefined) {
        acceptDraft(result.draft, clientIdValue)
      } else if (result.changed && result.draft_suppressed === true && result.signature !== undefined) {
        // The ledger moved but the ~10s compile floor holds — flush once the
        // floor lifts so the final state always becomes a draft.
        scheduleFlush(result.signature)
        setNotice('Change noted — compiling after the draft floor.')
      } else if (!result.changed && hasWords) {
        setNotice(null)
      }
    } catch (error) {
      setNotice(`Fact screening unavailable — retrying: ${(error as Error).message}`)
    } finally {
      sendingRef.current = false
      setScreening(false)
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
    if (!segment.final) {
      tailRef.current = segment.text
      return
    }
    tailRef.current = ''
    digestRef.current += `${segment.text}\n`
    if (digestRef.current.length > 8000) digestRef.current = digestRef.current.slice(-6000)
    // Coalesce repeated finals into one pending slot per index.
    const existing = pendingRef.current.findIndex((entry) => entry.index === segment.index)
    if (existing >= 0) pendingRef.current[existing] = segment
    else pendingRef.current.push(segment)
  }

  const startRecording = () => {
    if (engineChoice === null || clientId === null || workflowId === null) return
    setNotice(null)
    engineTagRef.current = engineChoice
    recordingGenerationRef.current += 1
    for (const timer of postStopTimersRef.current) window.clearTimeout(timer)
    postStopTimersRef.current = []
    engineRef.current = createEngine(engineChoice, {
      onSegment: handleSegment,
      onError: (message, kind) => {
        setNotice(message)
        if (kind === 'fatal') {
          engineRef.current?.stop()
          engineRef.current = null
          setRecording(false)
        }
      },
    }, { sessionId: sessionIdRef.current })
    engineRef.current.start()
    setRecording(true)
  }

  const stopRecording = () => {
    engineRef.current?.stop()
    engineRef.current = null
    tailRef.current = ''
    setRecording(false)
    // Final rolling tick goes through the same screen path. If the ~5s screen
    // cadence holds it, retry a few times so the call's last words always get
    // screened (the words stay queued; nothing is dropped).
    const generation = recordingGenerationRef.current
    void sendTick()
    for (let attempt = 1; attempt <= 3; attempt++) {
      postStopTimersRef.current.push(
        window.setTimeout(() => {
          if (recordingGenerationRef.current !== generation) return
          void sendTick()
        }, SCREEN_TICK_MS * attempt + 500),
      )
    }
  }

  // Rolling screen cadence: every ~5s the newest words (and the still-being-
  // spoken tail) go to the fact pipeline — not on sentence ends.
  useEffect(() => {
    if (!recording) return
    const interval = window.setInterval(() => void sendTick(), SCREEN_TICK_MS)
    return () => window.clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

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

  // Captions stay pinned to the newest words while the call runs.
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

  // ONE continuously-growing transcript: words flattened across segments.
  // Keys are stable per word within an utterance (the Web Speech engine emits
  // interims and their final under the SAME index), so growing interim text
  // updates in place — only genuinely new words mount and fade in, and a
  // settled sentence solidifies without re-animating.
  const words = useMemo(() => {
    const out: { id: string; text: string; final: boolean; time: string | null }[] = []
    for (const segment of captions) {
      if (segment.final) {
        out.push({
          id: `time-${segment.index}`,
          text: new Date(segment.at).toLocaleTimeString('en-SG', { hour12: false }),
          final: true,
          time: null,
        })
      }
      const parts = segment.text.split(/\s+/).filter((part) => part.length > 0)
      parts.forEach((part, position) => {
        out.push({ id: `w-${engineTagRef.current}-${segment.index}-${position}`, text: part, final: segment.final, time: null })
      })
    }
    return out
  }, [captions])

  const activeFacts = useMemo(() => facts.filter((entry) => entry.active), [facts])

  const engineLabel =
    engineChoice === 'server'
      ? 'Server transcription ready'
      : engineChoice === 'browser'
        ? 'Browser transcription (Chrome)'
        : canRecord
          ? 'Checking transcription engines…'
          : 'Live transcription needs Chrome or a configured server engine.'

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
          {screening && (
            <Badge tone="neutral">
              <span className="animate-pulse">screening…</span>
            </Badge>
          )}
          {activeFacts.length > 0 && (
            <span className="shrink-0 text-xs text-slate-400">
              {activeFacts.length} facts captured
            </span>
          )}
        </div>
        {!canRecord || engineChoice === null ? (
          <p className="text-xs font-medium text-slate-500">{engineLabel}</p>
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

      {/* Live captions pane — one growing transcript, word-level fades */}
      <div
        ref={captionsRef}
        className="scroll-slim mx-5 my-3 min-h-0 flex-1 overflow-y-auto rounded-xl bg-slate-50 px-4 py-3"
        aria-label="Live captions"
      >
        {words.length === 0 ? (
          <p className="text-xs text-slate-400">
            {canRecord
              ? 'Press Start recording — the transcript grows word by word and keyed spec drafts appear below while you talk.'
              : engineLabel}
          </p>
        ) : (
          <p className="flex flex-wrap gap-x-[0.45ch] gap-y-1 font-mono text-xs leading-relaxed">
            {words.map((word) =>
              word.time !== null ? (
                <span
                  key={word.id}
                  className="mr-1 select-none self-center rounded bg-white px-1 font-sans text-[10px] text-slate-300"
                >
                  {word.text}
                </span>
              ) : (
                <span
                  key={word.id}
                  className={cn(
                    'animate-word-in break-words [overflow-wrap:anywhere] transition-colors duration-300',
                    word.final ? 'text-slate-600' : 'italic text-slate-400',
                  )}
                >
                  {word.text}
                </span>
              ),
            )}
          </p>
        )}
      </div>

      {/* Fact ledger — the source of truth the spec compiles from */}
      {activeFacts.length > 0 && (
        <div className="shrink-0 border-t border-slate-200 px-5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>Fact ledger</Eyebrow>
            <span className="text-xs text-slate-400">the spec compiles from these keys</span>
          </div>
          <ul className="scroll-slim mt-1.5 flex max-h-16 flex-wrap gap-1.5 overflow-y-auto">
            {activeFacts.map((entry) => (
              <li
                key={entry.key}
                className={cn(
                  'animate-word-in rounded-full border px-2 py-0.5 font-mono text-[11px]',
                  FACT_AREA_STYLES[entry.area] ?? 'border-slate-200 bg-slate-50 text-slate-600',
                )}
                title={`${entry.area} · last op ${entry.op} · applied ${entry.ops}×`}
              >
                {entry.key}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Draft rail */}
      <div className="shrink-0 border-t border-slate-200 px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <Eyebrow>Spec drafts</Eyebrow>
          {drafts.length > 0 && <span className="text-xs text-slate-400">{drafts.length} total</span>}
        </div>
        {drafts.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Numbered drafts appear here as the fact ledger changes. Publish stays on the right.
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
