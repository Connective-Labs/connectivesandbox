// Client feedback chat: the service-team thread in the client workspace.
// WhatsApp-style surface reusing the shared chat language (bubbles, day
// separators, stick-to-bottom). Every send is stored, classified server-side
// (closed set) and routed to the rep; the client's own message shows a small
// classification chip once the server confirms. The AI never talks to the
// client here — replies in the thread are the rep's, fetched quietly
// (unread badges only, no popups).

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Loader2, Paperclip, Send, X } from 'lucide-react'

import { Badge, Card } from '@/components/ui/Primitives'
import { Bubble, DaySeparator, isNewDay } from '@/components/chat/Bubble'
import { useStickToBottom } from '@/components/chat/useStickToBottom'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import {
  ensureRunSession,
  uploadArtifact,
  type ArtifactDescriptor,
} from '@/data/adapters/artifacts'
import {
  getMyFeedback,
  sendFeedback,
  type FeedbackClassification,
  type FeedbackMessage,
} from '@/data/adapters/feedback'

const POLL_MS = 15000

const CLASS_LABEL: Record<FeedbackClassification, string> = {
  wording: 'Wording',
  structure: 'Structure',
  accuracy: 'Accuracy',
  feature_request: 'Feature request',
  bug: 'Bug',
  question: 'Question',
}

interface PendingEntry {
  id: string
  body: string
  attachments: { filename: string; size: number }[]
}

/** Quiet classification chip shown on the client's own sent message. */
function ClassificationChip({ classification, fallback }: { classification: FeedbackClassification | null; fallback: boolean }) {
  if (classification === null) return null
  return (
    <span className="mt-1 flex items-center gap-1.5">
      <Badge tone="neutral">{fallback ? 'Logged' : `Logged · ${CLASS_LABEL[classification]}`}</Badge>
      <span className="text-[10px] text-slate-400">Routed to your service team</span>
    </span>
  )
}

export function FeedbackChat({ workflowId }: { workflowId: string | null }) {
  const [messages, setMessages] = useState<FeedbackMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<PendingEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const workflowRef = useRef(workflowId)
  workflowRef.current = workflowId

  const { ref: scrollRef, onScroll, stick } = useStickToBottom()
  useEffect(() => {
    stick()
  }, [messages, pending, stick])

  const refresh = useCallback(async () => {
    const rows = await getMyFeedback()
    setMessages(rows)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const addFiles = (incoming: FileList | File[]) => {
    setFiles((previous) => [...previous, ...Array.from(incoming)].slice(0, 6))
  }

  const removeFile = (index: number) => {
    setFiles((previous) => previous.filter((_, position) => position !== index))
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files)
  }

  const uploadAttachments = async (): Promise<ArtifactDescriptor[]> => {
    const target = workflowRef.current
    if (files.length === 0) return []
    if (target === null) throw new Error('Select a workflow before attaching files.')
    const session = await ensureRunSession(target)
    return Promise.all(files.map((file) => uploadArtifact(session.id, file)))
  }

  const send = async () => {
    const body = draft.trim()
    if (body.length === 0 || sending) return
    setSending(true)
    setError(null)
    setDraft('')
    const sentFiles = files
    setFiles([])
    setPending({
      id: `pending_${Date.now()}`,
      body,
      attachments: sentFiles.map((file) => ({ filename: file.name, size: file.size })),
    })
    try {
      const uploaded = await uploadAttachments()
      const result = await sendFeedback({
        body,
        workflow_id: workflowRef.current,
        attachments: uploaded.map((artifact) => ({ artifact_id: artifact.id, filename: artifact.filename })),
      })
      setPending(null)
      setMessages((previous) => [...previous, result.message])
    } catch (caught) {
      setPending(null)
      setDraft(body)
      setFiles(sentFiles)
      setError((caught as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <div>
          <p className="text-sm font-semibold text-ink">Feedback</p>
          <p className="text-xs text-slate-400">
            Messages go straight to your service team — we reply here.
          </p>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn(
          'scroll-slim min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-4',
          dragOver && 'bg-accent-tint',
        )}
        aria-label="Feedback thread"
      >
        {!loaded ? (
          <p className="py-8 text-center text-sm text-slate-400">Loading thread…</p>
        ) : messages.length === 0 && pending === null ? (
          <Card className="mx-auto mt-6 max-w-md p-4 text-center">
            <p className="text-sm font-medium text-ink">Tell us how the workflow is working for you.</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Wording tweaks, missing steps, wrong decisions, or anything broken — your message
              reaches the service team and we follow up here.
            </p>
          </Card>
        ) : null}
        {messages.map((message, index) => (
          <div key={message.id} className="space-y-2.5">
            {isNewDay(index > 0 ? messages[index - 1].created_at : undefined, message.created_at) && (
              <DaySeparator iso={message.created_at} />
            )}
            <Bubble role={message.direction === 'client' ? 'user' : 'assistant'} at={message.created_at}>
              <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {message.body}
              </span>
              {message.attachments.length > 0 && (
                <span className="mt-1.5 flex flex-wrap gap-1">
                  {message.attachments.map((attachment) => (
                    <span
                      key={attachment.artifact_id}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500"
                    >
                      {attachment.filename}
                    </span>
                  ))}
                </span>
              )}
              {message.direction === 'client' && (
                <ClassificationChip
                  classification={message.classification}
                  fallback={message.classification_fallback}
                />
              )}
            </Bubble>
          </div>
        ))}
        {pending !== null && (
          <Bubble role="user" at={pending.id} sending>
            <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {pending.body}
            </span>
            {pending.attachments.length > 0 && (
              <span className="mt-1.5 flex flex-wrap gap-1">
                {pending.attachments.map((attachment) => (
                  <span
                    key={attachment.filename}
                    className="rounded-lg border border-white/30 px-2 py-0.5 text-xs"
                  >
                    {attachment.filename}
                  </span>
                ))}
              </span>
            )}
          </Bubble>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="shrink-0 px-5 pb-1 text-xs text-red-600">
          {error}
        </p>
      )}

      {files.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 px-5 pb-2">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600"
            >
              <span className="max-w-40 truncate">{file.name}</span>
              <span className="text-slate-400">{formatBytes(file.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(index)}
                aria-label={`Remove ${file.name}`}
                className="text-slate-400 transition hover:text-red-500"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      <form
        className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-5 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Attach files"
          onChange={(event) => {
            if (event.target.files !== null) addFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-ink"
        >
          <Paperclip size={16} aria-hidden="true" />
        </button>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write feedback…"
          aria-label="Feedback message"
          disabled={sending}
          className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          aria-label="Send feedback"
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition',
            draft.trim().length > 0
              ? 'border-accent bg-accent text-white hover:bg-accent-hover active:bg-accent-pressed'
              : 'border-slate-300 bg-white text-slate-400',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {sending ? (
            <Loader2 size={16} aria-hidden="true" className="animate-spin" />
          ) : (
            <Send size={16} aria-hidden="true" />
          )}
        </button>
      </form>
    </div>
  )
}
