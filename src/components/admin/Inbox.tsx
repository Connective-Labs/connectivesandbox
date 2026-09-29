// Admin Inbox: the rep-side feedback surface. Left: client threads
// (WhatsApp-thread-list UX — name, last message preview, unread count,
// classification chip). Right: the conversation, the rep's reply composer,
// and proposed AI drafts — each shown with the classification, the client's
// words, and a plain-language diff, with Test (load into the live preview
// sandbox and click through as the client would), Publish (existing publish
// path), and Discard. The AI never talks to the client and never publishes —
// the rep is the UAT gate. A per-client change log answers "it changed!"
// with facts. Notifications stay quiet: unread badges, no popups.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Inbox as InboxIcon, Send, Trash2, X } from 'lucide-react'

import { Badge, Eyebrow, GhostButton, PrimaryButton, Skeleton, useGraceSkeleton } from '@/components/ui/Primitives'
import { Bubble, DaySeparator, isNewDay } from '@/components/chat/Bubble'
import { useStickToBottom } from '@/components/chat/useStickToBottom'
import { cn } from '@/lib/utils'
import type { WorkflowSpec } from '@/engine/types'
import {
  getAdminThread,
  listFeedbackThreads,
  sendRepReply,
  type FeedbackClassification,
  type FeedbackDraft,
  type FeedbackMessage,
  type FeedbackThread,
} from '@/data/adapters/feedback'
import { discardDraft, markDraftPublished } from '@/data/adapters/live'
import { saveWorkflowSpec } from '@/data/adapters/workflows'
import { formatDateTime } from '@/lib/format'

const POLL_MS = 20000

const CLASS_LABEL: Record<FeedbackClassification, string> = {
  wording: 'Wording',
  structure: 'Structure',
  accuracy: 'Accuracy',
  feature_request: 'Feature request',
  bug: 'Bug',
  question: 'Question',
}

const CLASS_TONE: Record<FeedbackClassification, 'valid' | 'invalid' | 'neutral'> = {
  wording: 'valid',
  structure: 'valid',
  accuracy: 'invalid',
  feature_request: 'neutral',
  bug: 'invalid',
  question: 'neutral',
}

export interface InboxProps {
  /** The thread to open initially (the rail's selected client), if any. */
  initialClientId: string | null
  /** Load a draft spec into the existing live preview sandbox (right column). */
  onLoadSpec: (spec: WorkflowSpec) => void
  /** Tell the parent which draft Publish should flag as published. */
  onActiveDraftChange: (draft: FeedbackDraft | null) => void
  /** Point the rail at this client+workflow so Publish targets the right row. */
  onSelectWorkflow: (clientId: string, workflowId: string) => void
}

export function Inbox({ initialClientId, onLoadSpec, onActiveDraftChange, onSelectWorkflow }: InboxProps) {
  const [threads, setThreads] = useState<FeedbackThread[]>([])
  const [activeClientId, setActiveClientId] = useState<string | null>(initialClientId)
  const [messages, setMessages] = useState<FeedbackMessage[]>([])
  const [drafts, setDrafts] = useState<FeedbackDraft[]>([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmingDiscardId, setConfirmingDiscardId] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  const { ref: scrollRef, onScroll, stick } = useStickToBottom()
  useEffect(() => {
    stick()
  }, [messages, stick])

  // Skeleton discipline (polish 6): skeletons until the first poll resolves.
  const [threadsLoaded, setThreadsLoaded] = useState(false)
  const threadsLoading = useGraceSkeleton(!threadsLoaded)
  const refreshThreads = useCallback(async () => {
    setThreads(await listFeedbackThreads())
    setThreadsLoaded(true)
  }, [])

  const refreshThread = useCallback(async (clientId: string) => {
    const { messages: rows, drafts: proposals } = await getAdminThread(clientId)
    setMessages(rows)
    setDrafts(proposals)
  }, [])

  useEffect(() => {
    void refreshThreads()
    const timer = window.setInterval(() => void refreshThreads(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshThreads])

  useEffect(() => {
    if (activeClientId === null) {
      setMessages([])
      setDrafts([])
      return
    }
    void refreshThread(activeClientId)
  }, [activeClientId, refreshThread])

  // Follow the rail: if the rep picks a client there, open that thread.
  useEffect(() => {
    if (initialClientId !== null) setActiveClientId(initialClientId)
  }, [initialClientId])

  const activeThread = threads.find((thread) => thread.client_id === activeClientId) ?? null
  const totalUnread = useMemo(
    () => threads.reduce((sum, thread) => sum + thread.unread, 0),
    [threads],
  )

  const proposals = drafts.filter((draft) => !draft.published)
  const publishedLog = drafts.filter((draft) => draft.published)
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  )

  const sendReply = async () => {
    const body = reply.trim()
    if (body.length === 0 || sending || activeClientId === null) return
    setSending(true)
    setReply('')
    try {
      const message = await sendRepReply(activeClientId, body)
      setMessages((previous) => [...previous, message])
    } catch (error) {
      setReply(body)
      setNotice((error as Error).message)
    } finally {
      setSending(false)
    }
  }

  const testDraft = (draft: FeedbackDraft) => {
    onActiveDraftChange(draft)
    if (draft.workflow_id !== null) onSelectWorkflow(draft.client_id, draft.workflow_id)
    onLoadSpec(draft.spec)
    setNotice(`Draft v${draft.version} loaded into the preview — click through it, then Publish to Client.`)
  }

  const publishDraft = async (draft: FeedbackDraft) => {
    if (draft.workflow_id === null) return
    try {
      await saveWorkflowSpec(draft.workflow_id, draft.spec)
      await markDraftPublished(draft.id, true)
      setNotice(`Published v${draft.version} — the client sees the change on their next visit.`)
      onActiveDraftChange(null)
      if (activeClientId !== null) void refreshThread(activeClientId)
    } catch (error) {
      setNotice((error as Error).message)
    }
  }

  const discard = async (draft: FeedbackDraft) => {
    setConfirmingDiscardId(null)
    try {
      await discardDraft(draft.id)
      if (activeClientId !== null) void refreshThread(activeClientId)
    } catch (error) {
      setNotice((error as Error).message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Thread list */}
      <div className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <Eyebrow>Threads</Eyebrow>
          {totalUnread > 0 && <Badge tone="invalid">{totalUnread} unread</Badge>}
        </div>
        <div className="scroll-slim min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {threadsLoading && (
            <div className="space-y-1 px-1 pt-1" aria-hidden="true">
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>
          )}
          {!threadsLoading && threads.length === 0 && (
            <div className="px-3 py-6 text-center">
              <InboxIcon size={20} aria-hidden="true" className="mx-auto text-slate-300" />
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                No client messages yet. The Feedback tab in the client workspace starts a thread.
              </p>
            </div>
          )}
          {threads.map((thread) => (
            <button
              key={thread.client_id}
              type="button"
              onClick={() => setActiveClientId(thread.client_id)}
              aria-current={thread.client_id === activeClientId ? 'true' : undefined}
              className={cn(
                'block w-full rounded-lg px-3 py-2.5 text-left transition-colors',
                thread.client_id === activeClientId
                  ? 'bg-white text-ink shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-600 hover:bg-white/60 hover:text-ink',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {thread.client_name.length > 0 ? thread.client_name : 'Client'}
                </span>
                {thread.unread > 0 && (
                  <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">
                    {thread.unread}
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                {thread.latest_classification !== null && (
                  <Badge tone={CLASS_TONE[thread.latest_classification]}>
                    {CLASS_LABEL[thread.latest_classification]}
                  </Badge>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                  {thread.last_direction === 'rep' ? 'You: ' : ''}
                  {thread.last_message}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Conversation + proposals */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeClientId === null ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="max-w-sm text-sm leading-relaxed text-slate-400">
              Pick a thread on the left. Client messages are classified and, for wording or
              structure, come with a proposed draft you can test before publishing.
            </p>
          </div>
        ) : (
          <>
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="scroll-slim min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-4"
              aria-label="Feedback conversation"
            >
              <p className="text-center text-xs font-semibold uppercase tracking-widest text-slate-400">
                {activeThread?.client_name ?? 'Client'} · service thread
              </p>
              {messages.map((message, index) => (
                <div key={message.id} className="space-y-2.5">
                  {isNewDay(index > 0 ? messages[index - 1].created_at : undefined, message.created_at) && (
                    <DaySeparator iso={message.created_at} />
                  )}
                  <Bubble role={message.direction === 'rep' ? 'user' : 'assistant'} at={message.created_at}>
                    <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {message.body}
                    </span>
                    {message.direction === 'client' && message.classification !== null && (
                      <span className="mt-1 flex items-center gap-1.5">
                        <Badge tone={CLASS_TONE[message.classification]}>
                          {CLASS_LABEL[message.classification]}
                        </Badge>
                        {message.referenced_judge !== null && (
                          <Badge tone="neutral">re: {message.referenced_judge.replace(/_/g, ' ')}</Badge>
                        )}
                      </span>
                    )}
                  </Bubble>
                </div>
              ))}
            </div>

            {/* Proposed drafts (rep = UAT gate) */}
            {proposals.length > 0 && (
              <div className="shrink-0 space-y-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
                <Eyebrow>Proposed drafts</Eyebrow>
                {proposals.map((draft) => {
                  const source = draft.feedback_message_id !== null ? messageById.get(draft.feedback_message_id) ?? null : null
                  return (
                    <div key={draft.id} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-ink">
                          Draft v{draft.version}
                          <span className="ml-2 font-normal text-slate-400">
                            {formatDateTime(draft.created_at)}
                          </span>
                        </p>
                        {source?.classification != null && (
                          <Badge tone={CLASS_TONE[source.classification]}>{CLASS_LABEL[source.classification]}</Badge>
                        )}
                      </div>
                      {source !== null && (
                        <p className="mt-1.5 line-clamp-2 text-xs italic leading-relaxed text-slate-500">
                          “{source.body.length > 160 ? `${source.body.slice(0, 157)}…` : source.body}”
                        </p>
                      )}
                      <p className="mt-1.5 text-sm leading-relaxed text-ink">{draft.delta_summary}</p>
                      <div className="mt-2.5 flex items-center gap-2">
                        <GhostButton onClick={() => testDraft(draft)} className="px-3 py-1.5 text-xs">
                          Test
                        </GhostButton>
                        <PrimaryButton
                          onClick={() => void publishDraft(draft)}
                          disabled={draft.workflow_id === null}
                          title={draft.workflow_id === null ? 'No workflow attached to this feedback' : undefined}
                          className="px-3 py-1.5 text-xs"
                        >
                          Publish
                        </PrimaryButton>
                        {confirmingDiscardId === draft.id ? (
                          <span className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void discard(draft)}
                              className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-red-700"
                            >
                              Confirm discard
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingDiscardId(null)}
                              aria-label="Cancel discard"
                              className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-ink"
                            >
                              <X size={13} aria-hidden="true" />
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmingDiscardId(draft.id)}
                            aria-label={`Discard draft v${draft.version}`}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Change log — approved AI changes with timestamps */}
            {publishedLog.length > 0 && (
              <div className="shrink-0 border-t border-slate-200 px-5 py-2">
                <button
                  type="button"
                  onClick={() => setShowLog((previous) => !previous)}
                  aria-expanded={showLog}
                  className="text-xs font-semibold text-slate-500 transition hover:text-accent"
                >
                  Change log ({publishedLog.length}) {showLog ? '▲' : '▼'}
                </button>
                {showLog && (
                  <ul className="mt-1.5 space-y-1 pb-1">
                    {publishedLog.map((draft) => (
                      <li key={draft.id} className="text-xs leading-relaxed text-slate-500">
                        <span className="font-mono text-slate-400">{formatDateTime(draft.created_at)}</span>
                        {' — '}
                        {draft.delta_summary} <span className="text-slate-400">(v{draft.version}, published)</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {notice !== null && (
              <p role="status" className="shrink-0 px-5 pb-1 text-xs font-medium text-emerald-700">
                {notice}
              </p>
            )}

            <form
              className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-5 py-3"
              onSubmit={(event) => {
                event.preventDefault()
                void sendReply()
              }}
            >
              <input
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder={`Reply to ${activeThread?.client_name ?? 'client'}…`}
                aria-label="Reply to client"
                disabled={sending}
                className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={sending || reply.trim().length === 0}
                aria-label="Send reply"
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition',
                  reply.trim().length > 0
                    ? 'border-accent bg-accent text-white hover:bg-accent-hover active:bg-accent-pressed'
                    : 'border-slate-300 bg-white text-slate-400',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {sending ? <Check size={15} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
