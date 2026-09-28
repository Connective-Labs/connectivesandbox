// Guided workflow creation (polish 5). "New workflow" opens this picker —
// one card per named recipe from docs/modules.md, plus "Something else" for a
// plain chat. Picking a recipe creates the workflow and pre-fills the builder
// chat with a first message naming the client and the business pattern, so
// the internal person only edits the bracketed specifics and sends.
//
// Extending: add an entry to RECIPES. Nothing else needs to change — the
// list IS the picker. Recipes must stay aligned with the named recipes in
// docs/modules.md; the builder's interrogation refines the bracketed gaps.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Camera, ClipboardCheck, Copy, FileText, MessagesSquare } from 'lucide-react'

import { GhostButton, PrimaryButton } from '@/components/ui/Primitives'
import { cn } from '@/lib/utils'

export interface BuilderRecipe {
  id: 'photo-triage' | 'document-intake' | 'approval-desk' | 'something-else'
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

export const RECIPES: readonly BuilderRecipe[] = [
  {
    id: 'photo-triage',
    name: 'Photo triage',
    description: 'Photos in, triage out, human escalation',
    shape: 'file_upload · 3 judges · escalate',
    icon: Camera,
    seed: (client) =>
      `My client is ${client ?? '[client]'}. Customers send us photos and we need to decide: ` +
      'handle straight away, ask one follow-up question, or escalate to a person. Build the workflow. ' +
      'The details to pin down: what customers are photographing ([what they clean or repair]), ' +
      'what makes a photo unusable ([legibility bar]), and the one follow-up question customers ' +
      'answer reliably ([follow-up question]).',
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
}: {
  open: boolean
  clientName: string | null
  canDuplicate: boolean
  onClose: () => void
  /** Create the workflow, then pre-fill the builder chat with the seed. */
  onCreate: (name: string, seed: string | null) => void
  onDuplicate: () => void
}) {
  const [picked, setPicked] = useState<BuilderRecipe | null>(null)
  const [name, setName] = useState('')

  useEffect(() => {
    if (!open) setPicked(null)
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
            {picked === null ? (
              <>
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
