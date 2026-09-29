// Registry entry for dashboard panel type "triage_verdict" (module wave 1 —
// Clean Shades flagship): the large closed-set verdict chip (quotable /
// one-ask / site-visit style) + one-line reason + the chosen follow-up.
// Everything on this card reads from the decisions ledger — the verdict is
// the `judge_id` decision's answer, the reason line carries the judge's
// question and confidence, the follow-up chip the `follow_up_judge_id`
// decision. Nothing is fabricated; before a run the card shows its empty
// state.

import { motion } from 'framer-motion'

import type { DashboardPanel } from '@/engine/types'
import { formatAnswerValue, formatPercent } from '@/lib/format'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type TriageVerdictPanel = Extract<DashboardPanel, { type: 'triage_verdict' }>

export default function TriageVerdict({ panel }: { panel: TriageVerdictPanel }) {
  const { decisions, runStatus } = useWorkspace()
  const verdictRow = decisions.find((row) => row.judge_id === panel.judge_id)
  const followUpRow =
    panel.follow_up_judge_id !== undefined
      ? decisions.find((row) => row.judge_id === panel.follow_up_judge_id)
      : undefined

  if (runStatus === 'running') {
    return (
      <div className="space-y-3">
        <Skeleton className="h-3.5 w-28" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-11 w-36 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </div>
      </div>
    )
  }

  if (verdictRow === undefined) {
    return (
      <div className="space-y-2">
        <h3 className="font-semibold tracking-tight text-ink">Triage verdict</h3>
        <p className="text-sm text-slate-400">
          No verdict yet — run the workflow and the triage decision lands here.
        </p>
      </div>
    )
  }

  const verdictLabel =
    panel.verdicts.find((entry) => entry.value === verdictRow.answer)?.label ??
    formatAnswerValue(verdictRow.answer)

  return (
    <div className="space-y-3">
      <h3 className="font-semibold tracking-tight text-ink">Triage verdict</h3>
      <div className="flex flex-wrap items-center gap-4">
        <motion.span
          key={verdictLabel}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="inline-flex items-center rounded-full bg-accent px-6 py-2.5 text-lg font-bold uppercase tracking-wide text-white shadow-sm"
        >
          {verdictLabel}
        </motion.span>
        <p className="max-w-xl text-sm text-slate-700">
          {verdictRow.question} ·{' '}
          <span className="font-semibold text-ink">{formatPercent(verdictRow.confidence)}</span>{' '}
          confident
        </p>
      </div>
      {panel.follow_up_judge_id !== undefined && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 text-sm text-slate-600">
          Chosen follow-up:
          {followUpRow !== undefined ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-wash px-3 py-1 text-xs font-semibold text-ink">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
              {followUpRow.question} → {formatAnswerValue(followUpRow.answer)}
            </span>
          ) : (
            <span className="text-xs text-slate-400">No follow-up decision in the ledger.</span>
          )}
        </div>
      )}
    </div>
  )
}
