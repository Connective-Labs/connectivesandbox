// Cross-client clone (Phase 4): raw copy of the current workflow's spec into
// another client, for the "same build, different client" case. The curated
// path is save-as-template + instantiate; this is the quick one.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Copy } from 'lucide-react'

import { GhostButton, PrimaryButton } from '@/components/ui/Primitives'
import { cn } from '@/lib/utils'
import type { Client } from '@/data/types'

const MODAL_TRANSITION = { duration: 0.18, ease: 'easeOut' as const }

export function CloneWorkflowModal({
  open,
  workflowName,
  clients,
  currentClientId,
  onClose,
  onClone,
}: {
  open: boolean
  workflowName: string | null
  clients: Client[]
  currentClientId: string | null
  onClose: () => void
  /** Throws on failure; the modal surfaces the error. */
  onClone: (targetClientId: string, name: string) => Promise<void>
}) {
  const targets = clients.filter((client) => client.id !== currentClientId)
  const [targetId, setTargetId] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setBusy(false)
      setError(null)
      return
    }
    setName(`${workflowName ?? 'workflow'} copy`)
    setTargetId(targets[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflowName])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onClose])

  const clone = async () => {
    if (busy || targetId === '' || name.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      await onClone(targetId, name.trim())
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
          key="clone-workflow"
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
            aria-label="Copy workflow to another client"
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={MODAL_TRANSITION}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Copy size={14} aria-hidden="true" className="text-accent" />
              Copy to another client
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              Copies the current spec as-is — the rep gate applies on the other side.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="clone-target" className="text-xs font-semibold text-ink">
                  Target client
                </label>
                {targets.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-500">No other client to copy to yet.</p>
                ) : (
                  <select
                    id="clone-target"
                    value={targetId}
                    onChange={(event) => setTargetId(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                  >
                    {targets.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label htmlFor="clone-name" className="text-xs font-semibold text-ink">
                  Workflow name
                </label>
                <input
                  id="clone-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void clone()
                  }}
                  autoFocus
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                />
              </div>
              {error !== null && (
                <p role="alert" className="text-xs font-medium text-red-600">
                  {error}
                </p>
              )}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <GhostButton onClick={onClose}>Cancel</GhostButton>
              <PrimaryButton
                onClick={() => void clone()}
                disabled={busy || targetId === '' || name.trim().length === 0}
                className={cn((busy || targetId === '' || name.trim().length === 0) && 'opacity-50')}
              >
                {busy ? 'Copying…' : 'Copy workflow'}
              </PrimaryButton>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
