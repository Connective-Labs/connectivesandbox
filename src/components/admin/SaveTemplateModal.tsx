// Save-as-template (Phase 2): turn a published workflow into a reusable
// library template. The rep names it and optionally chains it as a new
// version of an existing library template (lineage); the server computes
// the parameterisation slots from the workflow's spec.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Layers } from 'lucide-react'

import { GhostButton, PrimaryButton } from '@/components/ui/Primitives'
import { cn } from '@/lib/utils'
import { listTemplates, type WorkflowTemplate } from '@/data/adapters/templates'

const MODAL_TRANSITION = { duration: 0.18, ease: 'easeOut' as const }

export function SaveTemplateModal({
  open,
  workflowName,
  onClose,
  onSave,
}: {
  open: boolean
  workflowName: string | null
  onClose: () => void
  /** Throws on failure; the modal surfaces the error. */
  onSave: (name: string, asVersionOf: string | null) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [versionOf, setVersionOf] = useState<string | null>(null)
  const [library, setLibrary] = useState<WorkflowTemplate[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setBusy(false)
      setError(null)
      setVersionOf(null)
      return
    }
    setName(`${workflowName ?? 'workflow'} template`)
    void listTemplates()
      .then((rows) => setLibrary(rows.filter((row) => !row.is_curated)))
      .catch(() => setLibrary([]))
  }, [open, workflowName])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onClose])

  const save = async () => {
    if (busy || name.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      await onSave(name.trim(), versionOf)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="save-template"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MODAL_TRANSITION}
          onClick={() => {
            if (!busy) onClose()
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Save as template"
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={MODAL_TRANSITION}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Layers size={14} aria-hidden="true" className="text-accent" />
              Save as template
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              The library grows with every build — next client starts here, not from scratch.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="template-save-name" className="text-xs font-semibold text-ink">
                  Template name
                </label>
                <input
                  id="template-save-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void save()
                  }}
                  autoFocus
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                />
              </div>
              {library.length > 0 && (
                <div>
                  <label htmlFor="template-save-version-of" className="text-xs font-semibold text-ink">
                    Save as a new version of
                  </label>
                  <select
                    id="template-save-version-of"
                    value={versionOf ?? ''}
                    onChange={(event) => setVersionOf(event.target.value === '' ? null : event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                  >
                    <option value="">Nothing — a fresh template</option>
                    {library.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name} (v{template.version})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {error !== null && (
                <p role="alert" className="text-xs font-medium text-red-600">
                  {error}
                </p>
              )}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <GhostButton onClick={onClose}>Cancel</GhostButton>
              <PrimaryButton
                onClick={() => void save()}
                disabled={busy || name.trim().length === 0}
                className={cn((busy || name.trim().length === 0) && 'opacity-50')}
              >
                {busy ? 'Saving…' : 'Save to library'}
              </PrimaryButton>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
