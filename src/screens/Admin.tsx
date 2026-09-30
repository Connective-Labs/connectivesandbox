// Admin console: collapsible client/workflow rail (260px, hover flyout,
// click pins), workflow-builder chat scoped to the selected client+workflow
// (flex), and a 480px live preview column with raw-JSON editing, validation
// status, and Publish. The builder chat streams through the admin-chat Edge
// Function; the preview renders a loaded spec exactly as the workspace does.

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Building2, Check, ChevronDown, Pencil, Send, Trash2, Workflow, X } from 'lucide-react'

import AppTopBar from '@/components/AppTopBar'
import { RecipePicker, type TemplateInstantiateRequest } from '@/components/admin/RecipePicker'
import { SaveTemplateModal } from '@/components/admin/SaveTemplateModal'
import { CloneWorkflowModal } from '@/components/admin/CloneWorkflowModal'
import { LiveBuild } from '@/components/admin/LiveBuild'
import { CapabilitiesGuide } from '@/components/admin/CapabilitiesGuide'
import { Inbox } from '@/components/admin/Inbox'
import { DraftSpecProvider } from '@/components/SpecText'
import WorkspaceBody from '@/components/workspace/WorkspaceBody'
import { Bubble, DaySeparator, isNewDay } from '@/components/chat/Bubble'
import { Markdown } from '@/components/chat/Markdown'
import { TypingBubble } from '@/components/chat/TypingBubble'
import { useStickToBottom } from '@/components/chat/useStickToBottom'
import { CollapsibleRail } from '@/components/ui/CollapsibleRail'
import { Badge, Eyebrow, GhostButton, PrimaryButton, Skeleton } from '@/components/ui/Primitives'
import { safeParseWorkflowSpec } from '@/engine/schema'
import { specDiffSummary } from '@/engine/diff'
import type { WorkflowSpec } from '@/engine/types'
import {
  createClient,
  deleteClient,
  getClientAccessCode,
  listClients,
  renameClient,
} from '@/data/adapters/clients'
import { markDraftPublished } from '@/data/adapters/live'
import { listFeedbackThreads } from '@/data/adapters/feedback'
import { instantiateTemplate, saveTemplateFromWorkflow } from '@/data/adapters/templates'
import { planWorkflow } from '@/data/adapters/plan'
import { planToMarkdown } from '@/engine/plan'
import {
  cloneWorkflowTo,
  createWorkflow,
  deleteWorkflow,
  getWorkflowSpec,
  listWorkflows,
  renameWorkflow,
  saveWorkflowSpec,
  updateWorkflowDescription,
} from '@/data/adapters/workflows'
import {
  getBuilderHistory,
  sendBuilderMessage,
  type BuilderChatMessage,
} from '@/data/adapters/builderChat'
import type { Client, WorkflowSummary } from '@/data/types'
import { WorkspaceProvider } from '@/state/workspace'
import { cn } from '@/lib/utils'

/** Rail loading skeleton (polish 6): three brand rows, no layout jump. */
function RailSkeletonRows() {
  return (
    <div className="space-y-1 px-3 py-1" aria-hidden="true">
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="h-10 w-full rounded-lg" />
    </div>
  )
}

type SpecValidation =
  | { state: 'empty' }
  | { state: 'invalid'; error: string }
  | { state: 'valid'; spec: WorkflowSpec }

function formatZodError(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid workflow spec.'
  const path = issue.path.map(String).join('.')
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message
}

// Scaled-down two-pane preview frame: laid out at 600x560, scaled to 72%.
const FRAME_W = 600
const FRAME_H = 560
const SCALE = 0.72

/** Collapsed JSON block labelled "Workflow spec" with a load action. */
function SpecBlock({ spec, onLoad }: { spec: WorkflowSpec; onLoad: (spec: WorkflowSpec) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3 rounded-xl border border-slate-200">
      <div className="flex items-center justify-between gap-2 rounded-t-xl bg-slate-50 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 font-mono text-xs uppercase tracking-widest text-slate-400"
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn('shrink-0 transition-transform', open && 'rotate-180')}
          />
          <span className="truncate">Workflow spec</span>
        </button>
        <button
          type="button"
          onClick={() => onLoad(spec)}
          className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-white transition hover:bg-accent-hover active:bg-accent-pressed"
        >
          Load into preview
        </button>
      </div>
      {open && (
        <pre className="scroll-slim max-h-40 overflow-auto rounded-b-xl bg-surface-dark p-3 font-mono text-xs leading-relaxed text-slate-200">
          {JSON.stringify(spec, null, 2)}
        </pre>
      )}
    </div>
  )
}

/** Tiny round icon control for row-level list actions. */
function RowButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition',
        danger ? 'hover:bg-red-50 hover:text-red-600' : 'hover:bg-slate-100 hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

/** Inline single-input row for renames and quick creation. Enter submits. */
function InlineInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  onSubmit,
  onCancel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit()
          if (event.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus
        className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none"
      />
      <RowButton label="Confirm" onClick={onSubmit}>
        <Check size={14} aria-hidden="true" />
      </RowButton>
      <RowButton label="Cancel" onClick={onCancel}>
        <X size={14} aria-hidden="true" />
      </RowButton>
    </div>
  )
}

/** One-line destructive confirm: label with Confirm/Cancel, no dialog. */
function InlineConfirm({
  label,
  onConfirm,
  onCancel,
}: {
  label: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className="flex items-center justify-between gap-2 px-1 py-1.5"
    >
      <p className="truncate text-xs font-medium text-slate-600">{label}</p>
      <span className="flex shrink-0 gap-1">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onConfirm()
          }}
          className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-red-700"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onCancel()
          }}
          className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:border-accent hover:text-accent"
        >
          Cancel
        </button>
      </span>
    </motion.div>
  )
}

export default function Admin() {
  const [clients, setClients] = useState<Client[]>([])
  // Skeleton discipline (polish 6): the rail shows brand skeletons until the
  // first data resolves, then swaps once.
  const [clientsLoaded, setClientsLoaded] = useState(false)
  const [workflowsLoaded, setWorkflowsLoaded] = useState(false)
  const [accessCodes, setAccessCodes] = useState<Record<string, string>>({})
  const [workflowCounts, setWorkflowCounts] = useState<Record<string, number>>({})
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)

  const [messages, setMessages] = useState<BuilderChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [chatPending, setChatPending] = useState(false)
  const composerRef = useRef<HTMLInputElement>(null)
  const chatAbortRef = useRef<AbortController | null>(null)
  const draftRef = useRef('')
  draftRef.current = draft

  // Builder chat sticks to the newest message (send, streamed tokens,
  // history load) unless the user deliberately scrolls up.
  const { ref: chatScrollRef, onScroll: onChatScroll, stick: stickChat } = useStickToBottom()
  useEffect(() => {
    stickChat()
  }, [messages, chatPending, stickChat])

  const [tab, setTab] = useState<'preview' | 'json'>('preview')
  const [specSource, setSpecSource] = useState('')
  const [publishedMessage, setPublishedMessage] = useState<string | null>(null)
  // Centre-column mode: builder chat (primary path), live transcription
  // build, or the feedback Inbox (rep-side service threads + AI proposals).
  const [mode, setMode] = useState<'chat' | 'live' | 'inbox'>('chat')
  const [storedSpec, setStoredSpec] = useState<WorkflowSpec | null>(null)
  // A draft awaiting the rep's Publish (transcript or feedback source); only
  // its id is needed to flag it published after the publish path succeeds.
  const [activeDraft, setActiveDraft] = useState<{ id: string } | null>(null)
  // Quiet unread badge for the Inbox tab (no popups — ever).
  const [unreadFeedback, setUnreadFeedback] = useState(0)

  // CRUD chrome: one open piece at a time per list.
  const [newClientOpen, setNewClientOpen] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientCode, setNewClientCode] = useState('')
  const [newClientError, setNewClientError] = useState<string | null>(null)
  const [renamingClientId, setRenamingClientId] = useState<string | null>(null)
  const [clientRenameValue, setClientRenameValue] = useState('')
  const [confirmingClientId, setConfirmingClientId] = useState<string | null>(null)
  // Guided creation (polish 5): New workflow opens the recipe picker; the
  // rail starts pinned so the client/workflow lists are visible un-hovered.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [railPinned, setRailPinned] = useState(true)
  const [renamingWorkflowId, setRenamingWorkflowId] = useState<string | null>(null)
  const [workflowRenameValue, setWorkflowRenameValue] = useState('')
  const [confirmingWorkflowId, setConfirmingWorkflowId] = useState<string | null>(null)
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionValue, setDescriptionValue] = useState('')

  useEffect(() => {
    void reloadClients(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Quiet unread polling for the Inbox tab; the Inbox itself re-fetches on
  // its own cadence — this only keeps the tab badge honest.
  useEffect(() => {
    let active = true
    const poll = () => {
      void listFeedbackThreads().then((threads) => {
        if (active) setUnreadFeedback(threads.reduce((sum, thread) => sum + thread.unread, 0))
      })
    }
    poll()
    const timer = window.setInterval(poll, 30000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  /** Point the rail at a client+workflow (Inbox Test/Publish targeting). */
  const selectClientWorkflow = (clientId: string, workflowId: string) => {
    setSelectedClientId(clientId)
    setSelectedWorkflowId(workflowId)
  }

  async function reloadClients(selectId: string | null) {
    const rows = await listClients()
    setClientsLoaded(true)
    const codeEntries = await Promise.all(
      rows.map(async (client) => [client.id, await getClientAccessCode(client.id)] as const),
    )
    const countEntries = await Promise.all(
      rows.map(async (client) => [client.id, (await listWorkflows(client.id)).length] as const),
    )
    setClients(rows)
    setAccessCodes(
      Object.fromEntries(codeEntries.filter((entry): entry is readonly [string, string] => entry[1] !== null)),
    )
    setWorkflowCounts(Object.fromEntries(countEntries))
    setSelectedClientId(selectId ?? rows[0]?.id ?? null)
  }

  async function reloadWorkflows(clientId: string, selectId: string | null) {
    const rows = await listWorkflows(clientId)
    setWorkflows(rows)
    setSelectedWorkflowId(selectId ?? rows[0]?.id ?? null)
    void reloadClients(clientId)
  }

  useEffect(() => {
    if (selectedClientId === null) {
      setWorkflows([])
      setWorkflowsLoaded(true)
      setSelectedWorkflowId(null)
      return
    }
    let active = true
    setWorkflowsLoaded(false)
    void listWorkflows(selectedClientId).then((rows) => {
      if (!active) return
      setWorkflows(rows)
      setWorkflowsLoaded(true)
      setSelectedWorkflowId((current) => {
        if (current !== null && rows.some((row) => row.id === current)) return current
        return rows[0]?.id ?? null
      })
    })
    return () => {
      active = false
    }
  }, [selectedClientId])

  // Selecting a workflow loads its stored spec into the editor and preview.
  useEffect(() => {
    if (selectedWorkflowId === null) {
      setSpecSource('')
      setStoredSpec(null)
      return
    }
    let active = true
    void getWorkflowSpec(selectedWorkflowId).then((loaded) => {
      if (active) {
        setSpecSource(loaded !== null ? JSON.stringify(loaded, null, 2) : '')
        setStoredSpec(loaded)
      }
    })
    return () => {
      active = false
    }
  }, [selectedWorkflowId])

  // Chat history is scoped to the selected client+workflow.
  const chatKey = selectedClientId !== null && selectedWorkflowId !== null
    ? `${selectedClientId}:${selectedWorkflowId}`
    : null
  useEffect(() => {
    if (chatKey === null) {
      setMessages([])
      return
    }
    let active = true
    void getBuilderHistory(chatKey).then((history) => {
      if (!active) return
      setMessages(history)
      // Seed durability (Phase 4): a recipe seed survives tab/workflow
      // switches — restore it while the build has not started yet.
      const workflowId = selectedWorkflowId
      if (workflowId !== null && history.length <= 1) {
        const seed = window.localStorage.getItem(`cs_seed_${workflowId}`)
        if (seed !== null && draftRef.current.trim().length === 0) setDraft(seed)
      }
    })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey])

  const validation = useMemo<SpecValidation>(() => {
    const source = specSource.trim()
    if (source.length === 0) return { state: 'empty' }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      return { state: 'invalid', error: `Invalid JSON — ${(error as Error).message}` }
    }
    // Fresh workflows store an empty placeholder spec (empty description,
    // no components/judges/panels) which cannot pass the schema. Show it as
    // "no spec" rather than a scary "invalid" while the builder is still
    // interrogating (polish 5).
    if (
      parsed !== null && typeof parsed === 'object' &&
      (Object.keys(parsed).length === 0 ||
        ((parsed as { description?: unknown }).description ?? '') === '' &&
        ((parsed as { intake?: { components?: unknown[] } }).intake?.components?.length ?? 0) === 0 &&
        ((parsed as { judges?: unknown[] }).judges?.length ?? 0) === 0)
    ) {
      return { state: 'empty' }
    }
    const result = safeParseWorkflowSpec(parsed)
    return result.success
      ? { state: 'valid', spec: result.data }
      : { state: 'invalid', error: formatZodError(result.error) }
  }, [specSource])

  const selectedClient = clients.find((client) => client.id === selectedClientId) ?? null
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null

  // --- Client CRUD (rides the admin-api gateway) ---

  const submitNewClient = async () => {
    const name = newClientName.trim()
    const code = newClientCode.trim()
    if (name.length === 0 || !/^\d{4}$/.test(code)) return
    try {
      const client = await createClient(name, code)
      setNewClientOpen(false)
      setNewClientName('')
      setNewClientCode('')
      setNewClientError(null)
      await reloadClients(client.id)
    } catch (error) {
      // Most likely a duplicate four-digit code (unique constraint) — the
      // form stays open with the reason instead of failing silently.
      const message = (error as Error).message
      setNewClientError(
        /duplicate|unique/i.test(message)
          ? `The code ${code} is already in use — pick another four-digit code.`
          : `Could not create the client — ${message}`,
      )
    }
  }

  const submitClientRename = async (clientId: string) => {
    const name = clientRenameValue.trim()
    if (name.length > 0) await renameClient(clientId, name)
    setRenamingClientId(null)
    await reloadClients(clientId)
  }

  const submitClientDelete = async (clientId: string) => {
    setConfirmingClientId(null)
    await deleteClient(clientId)
    await reloadClients(null)
  }

  // --- Workflow CRUD ---

  // Recipe picked: create the workflow, then pre-fill the composer with the
  // recipe's seed message — the person edits the bracketed specifics, sends.
  const createFromRecipe = async (name: string, seed: string | null) => {
    if (selectedClientId === null) return
    setPickerOpen(false)
    const workflow = await createWorkflow(selectedClientId, name, null)
    await reloadWorkflows(selectedClientId, workflow.id)
    if (seed !== null) {
      setDraft(seed)
      // Seed durability (Phase 4): survive tab/workflow switches until sent.
      window.localStorage.setItem(`cs_seed_${workflow.id}`, seed)
      composerRef.current?.focus()
    }
  }

  const duplicateCurrentWorkflow = async () => {
    if (selectedClientId === null || selectedWorkflowId === null || selectedWorkflow === null) return
    setPickerOpen(false)
    const spec = await getWorkflowSpec(selectedWorkflowId)
    const workflow = await createWorkflow(selectedClientId, `${selectedWorkflow.name} copy`, spec)
    await reloadWorkflows(selectedClientId, workflow.id)
  }

  // Template library (Phase 2): instantiate a saved build for this client,
  // or save the current published workflow into the library.
  const handleInstantiate = async (request: TemplateInstantiateRequest) => {
    if (selectedClientId === null) throw new Error('Select a client first')
    const result = await instantiateTemplate(request.templateId, selectedClientId, request.name, {
      description: request.description,
      slotValues: request.slotValues,
    })
    setPickerOpen(false)
    await reloadWorkflows(selectedClientId, result.workflow.id)
    setPublishedMessage(`Created “${result.workflow.name}” from the template — review and publish.`)
    window.setTimeout(() => setPublishedMessage(null), 4000)
  }

  const handleSaveTemplate = async (name: string, asVersionOf: string | null) => {
    if (selectedWorkflowId === null) throw new Error('No workflow selected')
    const template = await saveTemplateFromWorkflow(selectedWorkflowId, name, asVersionOf ?? undefined)
    setSaveTemplateOpen(false)
    setPublishedMessage(
      `Saved “${template.name}” to the library${asVersionOf !== null ? ` as v${template.version}` : ''}.`,
    )
    window.setTimeout(() => setPublishedMessage(null), 4000)
  }

  const handleClone = async (targetClientId: string, name: string) => {
    if (selectedWorkflowId === null) throw new Error('No workflow selected')
    const workflow = await cloneWorkflowTo(selectedWorkflowId, targetClientId, name)
    setCloneOpen(false)
    setPublishedMessage(`Copied “${workflow.name}” — select the target client to review and publish.`)
    window.setTimeout(() => setPublishedMessage(null), 4000)
  }

  // GLM planning stage (Phase 3): brief in — a new workflow, a compiled draft,
  // and a plan card in the builder transcript come out. The rep stays the gate.
  const handlePlan = async (brief: string) => {
    if (selectedClientId === null) throw new Error('Select a client first')
    const workflow = await createWorkflow(selectedClientId, 'Planned workflow', null)
    await reloadWorkflows(selectedClientId, workflow.id)
    const result = await planWorkflow(workflow.id, selectedClientId, brief)
    setMessages((previous) => [
      ...previous,
      {
        id: `bc_plan_${Date.now()}`,
        role: 'assistant' as const,
        content: planToMarkdown(result.plan),
        at: new Date().toISOString(),
        spec: result.draft.spec,
      },
    ])
    if (result.plan.open_questions.length > 0) {
      setDraft(
        `Open questions to settle:\n${result.plan.open_questions.map((question) => `- ${question}`).join('\n')}\n\n`,
      )
      composerRef.current?.focus()
    }
    setPickerOpen(false)
    setPublishedMessage('Plan ready — load the draft into the preview and publish when happy.')
    window.setTimeout(() => setPublishedMessage(null), 4000)
  }

  const submitWorkflowRename = async (workflowId: string) => {
    const name = workflowRenameValue.trim()
    if (name.length > 0 && selectedClientId !== null) {
      await renameWorkflow(workflowId, name)
      await reloadWorkflows(selectedClientId, workflowId)
      // Refresh the editor/preview so the spec carries the new name.
      const loaded = await getWorkflowSpec(workflowId)
      if (loaded !== null) setSpecSource(JSON.stringify(loaded, null, 2))
    }
    setRenamingWorkflowId(null)
  }

  const submitWorkflowDelete = async (workflowId: string) => {
    setConfirmingWorkflowId(null)
    if (selectedClientId === null) return
    await deleteWorkflow(workflowId)
    await reloadWorkflows(selectedClientId, null)
  }

  const submitDescription = async () => {
    if (selectedWorkflowId === null) return
    const description = descriptionValue.trim()
    await updateWorkflowDescription(selectedWorkflowId, description)
    setEditingDescription(false)
    if (selectedClientId !== null) await reloadWorkflows(selectedClientId, selectedWorkflowId)
    // Refresh the editor/preview so the spec carries the new description.
    const loaded = await getWorkflowSpec(selectedWorkflowId)
    if (loaded !== null) setSpecSource(JSON.stringify(loaded, null, 2))
  }

  // --- Builder chat + preview ---

  const loadSpecIntoPreview = (spec: WorkflowSpec) => {
    setSpecSource(JSON.stringify(spec, null, 2))
    setTab('preview')
  }

  const sendChat = () => {
    const content = draft.trim()
    if (content.length === 0 || chatPending || chatKey === null || selectedWorkflowId === null) return
    setDraft('')
    // The recipe seed is consumed once the rep sends it.
    window.localStorage.removeItem(`cs_seed_${selectedWorkflowId}`)
    const userMessage: BuilderChatMessage = {
      id: `bc_${Date.now()}`,
      role: 'user',
      content,
      at: new Date().toISOString(),
    }
    setMessages((previous) => [...previous, userMessage])
    setChatPending(true)
    void (async () => {
      // Streamed reply from the admin-chat gateway (GLM-5.3-Flash, spec
      // validated server-side against the frozen Zod schema). The turn is
      // cancellable — a build round can run for minutes.
      const abort = new AbortController()
      chatAbortRef.current = abort
      const assistantMessage: BuilderChatMessage = {
        id: `bc_${Date.now()}_assistant`,
        role: 'assistant',
        content: '',
        at: new Date().toISOString(),
      }
      setMessages((previous) => [...previous, assistantMessage])
      let streamed = ''
      try {
        const result = await sendBuilderMessage(selectedWorkflowId, content, (delta) => {
          streamed += delta
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessage.id ? { ...message, content: streamed } : message,
            ),
          )
        }, abort.signal)
        // Plain-language diff vs the currently loaded spec, so the rep sees
        // what a new proposal changes before loading it.
        const previousSpec = validation.state === 'valid' ? validation.spec : null
        const diffSummary =
          result.spec !== null && previousSpec !== null
            ? specDiffSummary(previousSpec, result.spec)
            : []
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content: result.content,
                  ...(result.spec !== null ? { spec: result.spec } : {}),
                  ...(diffSummary.length > 0 ? { diffSummary } : {}),
                  ...(result.validationError !== null
                    ? { content: `${result.content}\n\nSpec validation: ${result.validationError}` }
                    : {}),
                }
              : message,
          ),
        )
      } catch (error) {
        const cancelled = abort.signal.aborted
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content: cancelled
                    ? `${streamed}${streamed.length > 0 ? '\n\n' : ''}_Turn cancelled._`
                    : streamed.length > 0
                      ? `${streamed}\n\n${(error as Error).message}`
                      : (error as Error).message,
                }
              : message,
          ),
        )
      } finally {
        chatAbortRef.current = null
        setChatPending(false)
      }
    })()
  }

  const cancelChat = () => {
    chatAbortRef.current?.abort()
  }

  const publish = async () => {
    if (validation.state !== 'valid' || selectedWorkflow === null) return
    await saveWorkflowSpec(selectedWorkflow.id, validation.spec)
    // Publishing a live transcript draft follows the same publish path; the
    // draft is just flagged so the rail shows it was sent (rep = UAT gate).
    if (activeDraft !== null) void markDraftPublished(activeDraft.id, true).catch(() => {})
    setPublishedMessage(
      `Published “${validation.spec.name}” to ${selectedClient?.name ?? 'client'} — v${selectedWorkflow.version + 1}`,
    )
    if (selectedClientId !== null) await reloadWorkflows(selectedClientId, selectedWorkflow.id)
    window.setTimeout(() => setPublishedMessage(null), 4000)
  }

  // Left column content, shared by the collapsible rail (desktop) and the
  // stacked block (below lg).
  const leftColumn = (
    <div className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4">
      <div className="flex items-center justify-between gap-2 px-2">
        <Eyebrow>Clients</Eyebrow>
        <button
          type="button"
          onClick={() => setNewClientOpen(true)}
          className="text-xs font-semibold text-slate-500 transition hover:text-accent"
        >
          + New client
        </button>
      </div>
      {newClientOpen && (
        <div className="mt-2 space-y-1.5 rounded-lg border border-slate-200 bg-white p-2">
          <InlineInput
            value={newClientName}
            onChange={(value) => {
              setNewClientName(value)
              setNewClientError(null)
            }}
            placeholder="Client name"
            ariaLabel="New client name"
            onSubmit={submitNewClient}
            onCancel={() => {
              setNewClientOpen(false)
              setNewClientError(null)
            }}
          />
          <InlineInput
            value={newClientCode}
            onChange={(value) => {
              setNewClientCode(value)
              setNewClientError(null)
            }}
            placeholder="Four-digit code"
            ariaLabel="New client four-digit access code"
            onSubmit={submitNewClient}
            onCancel={() => {
              setNewClientOpen(false)
              setNewClientError(null)
            }}
          />
          {newClientError !== null && (
            <p role="alert" className="px-1 text-xs font-medium text-red-600">
              {newClientError}
            </p>
          )}
        </div>
      )}
      <div className="mt-3 space-y-1">
        {!clientsLoaded ? (
          <RailSkeletonRows />
        ) : (
          <>
          {clients.map((client) =>
          renamingClientId === client.id ? (
            <InlineInput
              key={client.id}
              value={clientRenameValue}
              onChange={setClientRenameValue}
              placeholder="Client name"
              ariaLabel="Rename client"
              onSubmit={() => void submitClientRename(client.id)}
              onCancel={() => setRenamingClientId(null)}
            />
          ) : confirmingClientId === client.id ? (
            <InlineConfirm
              key={client.id}
              label={`Delete ${client.name}?`}
              onConfirm={() => void submitClientDelete(client.id)}
              onCancel={() => setConfirmingClientId(null)}
            />
          ) : (
            <div
              key={client.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedClientId(client.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setSelectedClientId(client.id)
              }}
              aria-current={client.id === selectedClientId ? 'true' : undefined}
              className={cn(
                'group flex w-full cursor-pointer items-center gap-1 rounded-lg px-3 py-2.5 text-left transition-colors',
                client.id === selectedClientId
                  ? 'bg-white text-ink shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-600 hover:bg-white/60 hover:text-ink',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{client.name}</span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                  <span className="font-mono">#{accessCodes[client.id] ?? '····'}</span>
                  <span>
                    {workflowCounts[client.id] ?? 0}{' '}
                    {(workflowCounts[client.id] ?? 0) === 1 ? 'workflow' : 'workflows'}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <RowButton
                  label={`Rename ${client.name}`}
                  onClick={() => {
                    setClientRenameValue(client.name)
                    setRenamingClientId(client.id)
                  }}
                >
                  <Pencil size={13} aria-hidden="true" />
                </RowButton>
                <RowButton
                  label={`Delete ${client.name}`}
                  danger
                  onClick={() => setConfirmingClientId(client.id)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </RowButton>
              </span>
            </div>
          ),
        )}
          </>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between gap-2 px-2">
        <Eyebrow>Workflows</Eyebrow>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={selectedClientId === null}
          className="text-xs font-semibold text-slate-500 transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          + New workflow
        </button>
      </div>
      <div className="mt-3 space-y-1">
        {!workflowsLoaded ? (
          <RailSkeletonRows />
        ) : (
          <>
          {workflows.map((workflow) =>
          renamingWorkflowId === workflow.id ? (
            <InlineInput
              key={workflow.id}
              value={workflowRenameValue}
              onChange={setWorkflowRenameValue}
              placeholder="Workflow name"
              ariaLabel="Rename workflow"
              onSubmit={() => void submitWorkflowRename(workflow.id)}
              onCancel={() => setRenamingWorkflowId(null)}
            />
          ) : confirmingWorkflowId === workflow.id ? (
            <InlineConfirm
              key={workflow.id}
              label={`Delete ${workflow.name}?`}
              onConfirm={() => void submitWorkflowDelete(workflow.id)}
              onCancel={() => setConfirmingWorkflowId(null)}
            />
          ) : (
            <div
              key={workflow.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedWorkflowId(workflow.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setSelectedWorkflowId(workflow.id)
              }}
              aria-current={workflow.id === selectedWorkflowId ? 'true' : undefined}
              className={cn(
                'group flex w-full cursor-pointer items-center gap-1 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                workflow.id === selectedWorkflowId
                  ? 'bg-white font-medium text-accent shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-600 hover:bg-white/60 hover:text-ink',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{workflow.name}</span>
                <span className="mt-0.5 block text-xs text-slate-400">v{workflow.version}</span>
              </span>
              <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <RowButton
                  label={`Rename ${workflow.name}`}
                  onClick={() => {
                    setWorkflowRenameValue(workflow.name)
                    setRenamingWorkflowId(workflow.id)
                  }}
                >
                  <Pencil size={13} aria-hidden="true" />
                </RowButton>
                <RowButton
                  label={`Delete ${workflow.name}`}
                  danger
                  onClick={() => setConfirmingWorkflowId(workflow.id)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </RowButton>
              </span>
            </div>
          ),
        )}
          {workflows.length === 0 && (
            <p className="px-3 text-xs text-slate-400">No workflows yet — start one with New workflow.</p>
          )}
          </>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-white">
      <AppTopBar context="Admin" />
      {/* Action strip (polish 5): the primary admin actions stay visible
          here at every viewport — never hover-only, never icon-only. */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
        <p className="truncate text-xs text-slate-400">
          {selectedClient !== null
            ? `${selectedClient.name} · ${selectedWorkflow?.name ?? 'no workflow selected'}`
            : 'Add a client to start building workflows.'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <GhostButton
            onClick={() => {
              setRailPinned(true)
              setNewClientOpen(true)
            }}
            className="px-3.5 py-1.5 text-xs"
          >
            New client
          </GhostButton>
          <PrimaryButton
            onClick={() => setPickerOpen(true)}
            disabled={selectedClientId === null}
            title={selectedClientId === null ? 'Add a client first' : undefined}
            className="px-3.5 py-1.5 text-xs"
          >
            New workflow
          </PrimaryButton>
        </div>
      </div>
      <div className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* Left column: clients and workflows, collapsible rail on desktop */}
        <div className="shrink-0 border-b border-slate-200 bg-slate-50 lg:hidden">
          {leftColumn}
        </div>
        <CollapsibleRail
          width={260}
          label="clients"
          pinned={railPinned}
          onPinnedChange={setRailPinned}
          className="hidden border-r border-slate-200 bg-slate-50 lg:block"
          rail={
            <>
              <span
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400"
                title="Clients"
              >
                <Building2 size={16} />
              </span>
              <span
                aria-hidden="true"
                className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg text-slate-400"
                title="Workflows"
              >
                <Workflow size={16} />
              </span>
            </>
          }
        >
          {leftColumn}
        </CollapsibleRail>

        {/* Centre column: workflow-builder chat (primary) or live build
            (secondary ingestion channel), scoped to client+workflow */}
        <main className="flex min-h-[420px] min-w-0 flex-1 flex-col lg:min-h-0">
          <CapabilitiesGuide />
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-2.5">
            <div className="flex shrink-0 gap-1 rounded-full border border-slate-200 bg-white p-0.5">
              {(['chat', 'live', 'inbox'] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setMode(entry)}
                  aria-pressed={mode === entry}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                    mode === entry ? 'bg-accent text-white shadow-sm' : 'text-slate-500 hover:text-ink',
                  )}
                >
                  {entry === 'chat' ? 'Builder' : entry === 'live' ? 'Live build' : 'Inbox'}
                  {entry === 'inbox' && unreadFeedback > 0 && mode !== 'inbox' && (
                    <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                      {unreadFeedback}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <p className="shrink-0 truncate text-sm">
                <span className="font-semibold text-ink">{selectedClient?.name ?? 'No client selected'}</span>
                <span className="text-slate-400"> · {selectedWorkflow?.name ?? 'New workflow'}</span>
              </p>
              {editingDescription && selectedWorkflow !== null ? (
                <input
                  value={descriptionValue}
                  onChange={(event) => setDescriptionValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitDescription()
                    if (event.key === 'Escape') setEditingDescription(false)
                  }}
                  placeholder="Short description"
                  aria-label="Workflow description"
                  autoFocus
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  disabled={selectedWorkflow === null}
                  onClick={() => {
                    setDescriptionValue(selectedWorkflow?.description ?? '')
                    setEditingDescription(true)
                  }}
                  title="Edit description"
                  aria-label="Edit workflow description"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                    {selectedWorkflow?.description || 'No description'}
                  </span>
                  {selectedWorkflow !== null && (
                    <Pencil size={12} aria-hidden="true" className="shrink-0 text-slate-300 transition hover:text-accent" />
                  )}
                </button>
              )}
              {editingDescription && (
                <span className="flex shrink-0 gap-1">
                  <RowButton label="Save description" onClick={() => void submitDescription()}>
                    <Check size={13} aria-hidden="true" />
                  </RowButton>
                  <RowButton label="Cancel" onClick={() => setEditingDescription(false)}>
                    <X size={13} aria-hidden="true" />
                  </RowButton>
                </span>
              )}
            </div>
            {validation.state === 'valid' && <Badge tone="valid">valid</Badge>}
            {validation.state === 'invalid' && specSource.trim().length > 0 && (
              <Badge tone="invalid">invalid</Badge>
            )}
          </div>

          {mode === 'chat' ? (
            <>
          <div
            ref={chatScrollRef}
            onScroll={onChatScroll}
            className="scroll-slim mx-5 my-4 min-h-0 flex-1 space-y-2.5 overflow-y-auto rounded-xl bg-slate-50 px-3 py-3"
            aria-label="Builder chat"
          >
            {messages.map((message, index) => {
              // While the reply has not produced its first token, the typing
              // bubble below stands in for it — no empty bubble shell.
              if (
                message.role === 'assistant' &&
                message.content.length === 0 &&
                message.spec === undefined &&
                chatPending &&
                index === messages.length - 1
              ) {
                return null
              }
              return (
              <div key={message.id} className="space-y-2.5">
                {message.at !== undefined &&
                  isNewDay(index > 0 ? messages[index - 1].at : undefined, message.at) && (
                    <DaySeparator iso={message.at} />
                  )}
                <Bubble
                  role={message.role}
                  at={message.at ?? new Date().toISOString()}
                  sending={chatPending && index === messages.length - 1 && message.role === 'assistant'}
                >
                  {message.role === 'assistant' ? (
                    <Markdown>{message.content}</Markdown>
                  ) : (
                    <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</span>
                  )}
                  {message.diffSummary !== undefined && message.diffSummary.length > 0 && (
                    <div className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                        Changes vs current spec
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {message.diffSummary.map((change) => (
                          <li key={change} className="text-xs text-slate-600">
                            {change}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {message.spec !== undefined && (
                    <SpecBlock spec={message.spec} onLoad={loadSpecIntoPreview} />
                  )}
                </Bubble>
              </div>
              )
            })}
            {chatPending && (messages.length === 0 || messages[messages.length - 1].role === 'user' || (messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1].content.length === 0)) && (
              <TypingBubble />
            )}
          </div>

          <form
            className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-5 py-3"
            onSubmit={(event) => {
              event.preventDefault()
              sendChat()
            }}
          >
            <div className="min-w-0 flex-1">
              <input
                ref={composerRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Describe the workflow…"
                aria-label="Message the builder"
                disabled={chatPending}
                className="w-full rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50"
              />
              {/\[[^\]]*\]/.test(draft) && !chatPending && (
                <p role="status" className="mt-1 px-4 text-xs font-medium text-accent">
                  Fill in the bracketed specifics before sending.
                </p>
              )}
            </div>
            {chatPending ? (
              <button
                type="button"
                onClick={cancelChat}
                aria-label="Cancel the current turn"
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-500 transition hover:border-red-300 hover:text-red-600"
              >
                <X size={13} aria-hidden="true" /> Cancel
              </button>
            ) : (
              <button
                type="submit"
                disabled={draft.trim().length === 0}
                aria-label="Send message"
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition',
                  draft.trim().length > 0
                    ? 'border-accent bg-accent text-white hover:bg-accent-hover active:bg-accent-pressed'
                    : 'border-slate-300 bg-white text-slate-400',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                <Send size={16} aria-hidden="true" />
              </button>
            )}
          </form>
          <p className="shrink-0 pb-2.5 text-center text-xs font-semibold uppercase tracking-widest text-slate-400">
            GLM 5.3 Flash
          </p>
              </>
          ) : mode === 'live' ? (
            <LiveBuild
              clientId={selectedClientId}
              workflowId={selectedWorkflowId}
              storedSpec={storedSpec}
              onLoadSpec={loadSpecIntoPreview}
              onActiveDraftChange={setActiveDraft}
            />
          ) : (
            <Inbox
              initialClientId={selectedClientId}
              onLoadSpec={(spec) => {
                loadSpecIntoPreview(spec)
              }}
              onActiveDraftChange={setActiveDraft}
              onSelectWorkflow={selectClientWorkflow}
            />
          )}
        </main>

        {/* Right column: live preview, raw JSON, validation, publish */}
        <aside className="flex min-h-0 shrink-0 flex-col border-t border-slate-200 bg-slate-50 lg:w-[480px] lg:border-l lg:border-t-0">
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3">
            <div className="flex gap-1 rounded-full border border-slate-200 bg-white p-1">
              {(['preview', 'json'] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setTab(entry)}
                  aria-pressed={tab === entry}
                  className={cn(
                    'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                    tab === entry
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-slate-600 hover:text-ink',
                  )}
                >
                  {entry === 'preview' ? 'Preview' : 'Raw JSON'}
                </button>
              ))}
            </div>
            {validation.state === 'valid' ? (
              <Badge tone="valid">valid</Badge>
            ) : validation.state === 'invalid' ? (
              <Badge tone="invalid">invalid</Badge>
            ) : (
              <Badge tone="neutral">no spec</Badge>
            )}
          </div>

          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {tab === 'preview' ? (
              <div
                className="relative"
                style={{ width: FRAME_W * SCALE, height: FRAME_H * SCALE }}
              >
                <div
                  className="absolute left-0 top-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                  style={{
                    width: FRAME_W,
                    height: FRAME_H,
                    transform: `scale(${SCALE})`,
                    transformOrigin: 'top left',
                  }}
                >
                  {validation.state === 'valid' ? (
                    <WorkspaceProvider
                      key={validation.spec.name}
                      workflowId={selectedWorkflowId ?? 'preview'}
                      spec={validation.spec}
                    >
                      {/* Draft-rendered preview (polish 6): catalogue
                          placeholders show their draft style and GLM wording
                          fades in as the parallel string pass lands. */}
                      <DraftSpecProvider value>
                        <div className="flex h-full flex-col">
                          <p className="shrink-0 border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
                            {validation.spec.name}
                          </p>
                          <WorkspaceBody />
                        </div>
                      </DraftSpecProvider>
                    </WorkspaceProvider>
                  ) : (
                    <div className="flex h-full items-center justify-center p-8 text-center">
                      <p className="text-sm leading-relaxed text-slate-400">
                        No valid spec loaded. Select a workflow or load one from the chat.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <textarea
                value={specSource}
                onChange={(event) => setSpecSource(event.target.value)}
                spellCheck={false}
                aria-label="Workflow spec JSON"
                className="scroll-slim h-64 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 font-mono text-xs leading-relaxed text-ink focus:border-accent focus:outline-none"
                placeholder="Load or paste a WorkflowSpec JSON here."
              />
            )}

            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
              {validation.state === 'valid' ? (
                <p className="text-sm text-slate-600">Schema check passed.</p>
              ) : validation.state === 'invalid' ? (
                <p className="break-words font-mono text-xs leading-relaxed text-red-600">
                  {validation.error}
                </p>
              ) : (
                <p className="text-sm text-slate-400">Load a spec to validate.</p>
              )}
            </div>
          </div>

          <div className="shrink-0 space-y-2 border-t border-slate-200 px-4 py-3">
            <PrimaryButton
              onClick={() => void publish()}
              disabled={validation.state !== 'valid'}
              className="w-full"
            >
              Publish to Client
            </PrimaryButton>
            <GhostButton
              onClick={() => setSaveTemplateOpen(true)}
              disabled={validation.state !== 'valid' || selectedWorkflowId === null}
              className="w-full"
            >
              Save as template
            </GhostButton>
            {publishedMessage !== null && (
              <p role="status" className="text-xs font-medium text-emerald-700">
                {publishedMessage}
              </p>
            )}
          </div>
        </aside>
      </div>

      <RecipePicker
        open={pickerOpen}
        clientName={selectedClient?.name ?? null}
        canDuplicate={selectedWorkflow !== null}
        onClose={() => setPickerOpen(false)}
        onCreate={(name, seed) => void createFromRecipe(name, seed)}
        onDuplicate={() => void duplicateCurrentWorkflow()}
        onInstantiate={handleInstantiate}
        onPlan={handlePlan}
        onClone={() => setCloneOpen(true)}
      />
      <SaveTemplateModal
        open={saveTemplateOpen}
        workflowName={selectedWorkflow?.name ?? null}
        onClose={() => setSaveTemplateOpen(false)}
        onSave={handleSaveTemplate}
      />
      <CloneWorkflowModal
        open={cloneOpen}
        workflowName={selectedWorkflow?.name ?? null}
        clients={clients}
        currentClientId={selectedClientId}
        onClose={() => setCloneOpen(false)}
        onClone={handleClone}
      />
    </div>
  )
}
