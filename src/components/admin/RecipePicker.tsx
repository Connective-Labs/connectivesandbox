// Guided workflow creation (polish 5, library in Phase 2). "New workflow"
// opens this picker — one card per named recipe from docs/modules.md, the
// reusable template library, and "Something else" for a plain chat. Picking a
// recipe creates the workflow and pre-fills the builder chat with a first
// message naming the client and the business pattern; picking a library
// template opens the slot form and instantiates a real workflow.
//
// Extending: add an entry to RECIPES. Nothing else needs to change — the
// list IS the picker. Recipes must stay aligned with the named recipes in
// docs/modules.md; the builder's interrogation refines the bracketed gaps.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Camera, ClipboardCheck, Copy, FileText, MessagesSquare, MonitorCheck, Sparkles } from 'lucide-react'

import { GhostButton, PrimaryButton } from '@/components/ui/Primitives'
import { TemplateInstantiateForm, TemplateLibraryGrid } from '@/components/admin/TemplateFlow'
import { cn } from '@/lib/utils'
import { listTemplates, type WorkflowTemplate } from '@/data/adapters/templates'

export interface BuilderRecipe {
  id: 'photo-triage' | 'operations-desk' | 'document-intake' | 'approval-desk' | 'something-else'
  name: string
  /** 5-8 word fragment — copy diet applies. */
  description: string
  /** Intake/judge shape in micro-format. */
  shape: string
  icon: typeof Camera
  /**
   * First builder-chat message, client name interpolated. null = plain chat,
   * no pre-fill. Bracketed specifics are what the person edits before sending.
   */
  seed: (clientName: string | null) => string | null
}

export interface TemplateInstantiateRequest {
  templateId: string
  name: string
  description: string
  slotValues: Record<string, string | number>
}
export const RECIPES: readonly BuilderRecipe[] = [
  {
    id: 'photo-triage',
    name: 'Photo triage',
    description: 'Photos in, triage out, human escalation',
    shape: 'file_upload · 3 judges · escalate',
    icon: Camera,
    seed: (client) =>
      `My client is ${client ?? '[client]'}. Customers send us photos and we need to decide: ` +
      'handle straight away, ask one follow-up question, or escalate to a person. Build the workflow ' +
      'with the photo triage modules: photo_slot capture, the follow-up card, the triage verdict and ' +
      'quote panels, and the joined thread view. The details to pin down: what customers are ' +
      'photographing ([what they clean or repair]), what makes a photo unusable ([legibility bar]), ' +
      'the pre-authored follow-up asks ([follow-up questions]), and how prices band by job ' +
      'characteristics ([price bands]).',
  },
  {
    id: 'operations-desk',
    name: 'Operations desk',
    description: 'Tickets and orders on one queue, two buttons',
    shape: 'chat + form · 3 judges · queue',
    icon: MonitorCheck,
    seed: (client) =>
      `My client is ${client ?? '[client]'}. Work arrives by WhatsApp and email and we need ONE ` +
      'desk: items land in a queue with severity and state, alerts surface what needs chasing, and ' +
      'each row carries exactly two buttons — one to say yes, one to say not yet. Build the operations ' +
      'desk workflow. The details to pin down: what an item is ([ticket or order shape]), the ' +
      'severity levels ([severity levels]), the routing outcome ([routing outcomes]), and the two ' +
      'per-row actions ([action pair]).',
  },
  {
    id: 'document-intake',
    name: 'Document intake review',
    description: 'Claims and compliance packs, reviewed on arrival',
    shape: 'file_upload + form · 2 judges',
    icon: FileText,
    seed: (client) =>
      `My client is ${client ?? '[client]'}. Customers submit documents and we need to decide ` +
      'whether the pack is complete and readable enough to process, or goes back to them. Build the workflow. ' +
      'The details to pin down: which documents make a pack complete ([document list]), ' +
      'what makes a scan unusable ([legibility bar]), and who handles rejected packs ([escalation owner]).',
  },
  {
    id: 'approval-desk',
    name: 'Approval desk',
    description: 'Applications judged for eligibility and risk',
    shape: 'form intake · 2 judges',
    icon: ClipboardCheck,
    seed: (client) =>
      `My client is ${client ?? '[client]'}. Applicants submit details and we decide: ` +
      'approve, reject, or route to a person. Build the workflow. ' +
      'The details to pin down: what an applicant must provide ([intake fields]), ' +
      'the eligibility rule ([eligibility rule]), and the risk bar for auto-approval ([risk bar]).',
  },
  {
    id: 'something-else',
    name: 'Something else',
    description: 'Describe any workflow in plain words',
    shape: 'free-form chat · no template',
    icon: MessagesSquare,
    seed: () => null,
  },
]

const MODAL_TRANSITION = { duration: 0.18, ease: 'easeOut' as const }

export function RecipePicker({
  open,
  clientName,
  canDuplicate,
  onClose,
  onCreate,
  onDuplicate,
  onInstantiate,
  onPlan,
}: {
  open: boolean
  clientName: string | null
  canDuplicate: boolean
  onClose: () => void
  /** Create the workflow, then pre-fill the builder chat with the seed. */
  onCreate: (name: string, seed: string | null) => void
  onDuplicate: () => void
  /** Instantiate a library template with rep-customised slot values.
   *  Throws on failure (the error surfaces in the form); the parent closes
   *  the picker on success. */
  onInstantiate: (request: TemplateInstantiateRequest) => Promise<void>
  /** GLM planning stage: brief in, plan + compiled draft into the builder.
   *  Throws on failure; the parent closes the picker on success. */
  onPlan: (brief: string) => Promise<void>
}) {
  const [picked, setPicked] = useState<BuilderRecipe | null>(null)
  const [name, setName] = useState('')
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null)
  const [pickedTemplate, setPickedTemplate] = useState<WorkflowTemplate | null>(null)
  const [instantiating, setInstantiating] = useState(false)
  const [instantiateError, setInstantiateError] = useState<string | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [brief, setBrief] = useState('')
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setPicked(null)
      setPickedTemplate(null)
      setInstantiating(false)
      setInstantiateError(null)
      setPlanMode(false)
      setBrief('')
      setPlanning(false)
      setPlanError(null)
      return
    }
    // The library loads lazily per open; a failure leaves it hidden (the
    // recipes remain the primary path) rather than blocking the picker.
    void listTemplates()
      .then((rows) => setTemplates(rows))
      .catch(() => setTemplates([]))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const pick = (recipe: BuilderRecipe) => {
    setName(recipe.name)
    setPicked(recipe)
  }

  const confirm = () => {
    if (picked === null || name.trim().length === 0) return
    onCreate(name.trim(), picked.seed(clientName))
  }

  const confirmInstantiate = async (request: TemplateInstantiateRequest) => {
    setInstantiating(true)
    setInstantiateError(null)
    try {
      await onInstantiate(request)
    } catch (error) {
      setInstantiateError((error as Error).message)
    } finally {
      setInstantiating(false)
    }
  }

  const confirmPlan = async () => {
    const trimmed = brief.trim()
    if (trimmed.length === 0 || planning) return
    setPlanning(true)
    setPlanError(null)
    try {
      await onPlan(trimmed)
    } catch (error) {
      setPlanError((error as Error).message)
    } finally {
      setPlanning(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="recipe-picker"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MODAL_TRANSITION}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="New workflow"
            className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={MODAL_TRANSITION}
            onClick={(event) => event.stopPropagation()}
          >
            {planMode ? (
              <>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <Sparkles size={14} aria-hidden="true" className="text-accent" />
                  Plan it for me
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  Tell the planner about the client and the decision they make today. A recent
                  recorded call is picked up automatically.
                </p>
                <div className="mt-4">
                  <label htmlFor="plan-brief" className="sr-only">
                    Planning brief
                  </label>
                  <textarea
                    id="plan-brief"
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    rows={5}
                    autoFocus
                    placeholder={
                      clientName !== null
                        ? `e.g. ${clientName} clean curtains and blinds. Customers WhatsApp photos, we decide: quote now, ask one question, or visit…`
                        : 'e.g. My client cleans curtains. Customers WhatsApp photos, we decide: quote now, ask one question, or visit…'
                    }
                    className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none"
                  />
                </div>
                {planError !== null && (
                  <p role="alert" className="mt-2 text-xs font-medium text-red-600">
                    {planError}
                  </p>
                )}
                <div className="mt-4 flex items-center justify-between gap-2">
                  <GhostButton onClick={() => setPlanMode(false)}>Back</GhostButton>
                  <PrimaryButton
                    onClick={() => void confirmPlan()}
                    disabled={brief.trim().length === 0 || planning}
                    className={cn((brief.trim().length === 0 || planning) && 'opacity-50')}
                  >
                    {planning ? 'Planning…' : 'Plan the workflow'}
                  </PrimaryButton>
                </div>
              </>
            ) : pickedTemplate !== null ? (
              <TemplateInstantiateForm
                template={pickedTemplate}
                clientName={clientName}
                busy={instantiating}
                error={instantiateError}
                onBack={() => setPickedTemplate(null)}
                onConfirm={confirmInstantiate}
              />
            ) : picked === null ? (
              <>
                <div className="mb-3">
                  <button
                    type="button"
                    onClick={() => setPlanMode(true)}
                    className="group flex w-full items-center gap-2.5 rounded-xl border border-accent bg-accent-wash p-3 text-left transition hover:shadow-sm focus:border-accent focus:outline-none"
                  >
                    <Sparkles
                      size={16}
                      aria-hidden="true"
                      className="shrink-0 text-accent"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">
                        Plan it for me <span className="font-normal text-slate-500">(recommended)</span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-slate-600">
                        Describe the client — GLM plans the build, picks the template, and customises it.
                      </span>
                    </span>
                  </button>
                </div>
                <p className="text-sm font-semibold text-ink">Start a workflow</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {clientName !== null
                    ? `Pick the pattern closest to ${clientName}'s business.`
                    : 'Pick the pattern closest to the business.'}
                </p>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {RECIPES.map((recipe) => (
                    <button
                      key={recipe.id}
                      type="button"
                      onClick={() => pick(recipe)}
                      className="group rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-accent hover:shadow-sm focus:border-accent focus:outline-none"
                    >
                      <span className="flex items-center gap-2">
                        <recipe.icon
                          size={16}
                          aria-hidden="true"
                          className="shrink-0 text-slate-400 transition group-hover:text-accent"
                        />
                        <span className="truncate text-sm font-semibold text-ink">{recipe.name}</span>
                      </span>
                      <span className="mt-1 block text-xs leading-snug text-slate-600">
                        {recipe.description}
                      </span>
                      <span className="mt-1.5 block font-mono text-[10px] uppercase tracking-wide text-slate-400">
                        {recipe.shape}
                      </span>
                    </button>
                  ))}
                </div>
                {templates !== null && templates.length > 0 && (
                  <TemplateLibraryGrid
                    templates={templates.filter((template) => !template.is_curated)}
                    onPick={(template) => setPickedTemplate(template)}
                  />
                )}
                {canDuplicate && (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      onClick={() => {
                        setPicked(null)
                        onDuplicate()
                      }}
                      className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 transition hover:text-accent"
                    >
                      <Copy size={12} aria-hidden="true" />
                      Duplicate the current workflow instead
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink">{picked.name}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  Name it, then the builder takes over.
                </p>
                <div className="mt-4">
                  <label htmlFor="recipe-workflow-name" className="sr-only">
                    Workflow name
                  </label>
                  <input
                    id="recipe-workflow-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') confirm()
                      if (event.key === 'Escape') onClose()
                    }}
                    placeholder="Workflow name"
                    autoFocus
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="mt-4 flex items-center justify-between gap-2">
                  <GhostButton onClick={() => setPicked(null)}>Back</GhostButton>
                  <PrimaryButton
                    onClick={confirm}
                    disabled={name.trim().length === 0}
                    className={cn(name.trim().length === 0 && 'opacity-50')}
                  >
                    Start building
                  </PrimaryButton>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
