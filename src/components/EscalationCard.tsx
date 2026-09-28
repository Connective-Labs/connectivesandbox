// Registry entry for dashboard panel type "escalation_card" (module wave 1):
// named contact + reason + thread/record reference + one action button. The
// handoff shape the shipped WhatsApp assistant proved: escalate to a named
// person with the full conversation attached. With `judge_id` set, a linked
// decision line shows the flagging answer and confidence from the ledger;
// below-review confidence is highlighted. The action button is the one
// handoff tap — it confirms locally (demo surface; real dispatch is a
// backend phase).

import { useState } from 'react'
import type { DashboardPanel } from '@/engine/types'
import { formatAnswerValue, formatPercent } from '@/lib/format'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type EscalationCardPanel = Extract<DashboardPanel, { type: 'escalation_card' }>

export default function EscalationCard({ panel }: { panel: EscalationCardPanel }) {
  const { decisions, runStatus } = useWorkspace()
  const [sent, setSent] = useState(false)
  const linked =
    panel.judge_id !== undefined ? decisions.find((row) => row.judge_id === panel.judge_id) : undefined
  const flagged = linked?.disposition === 'escalated'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold tracking-tight text-ink">
            Escalate to {panel.contact} — {panel.reason}
          </p>
          {panel.reference !== undefined && (
            <p className="mt-0.5 text-xs text-slate-500">{panel.reference} · full conversation attached</p>
          )}
        </div>
        {sent ? (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
            Sent to {panel.contact}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setSent(true)}
            className="inline-flex items-center rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
          >
            {panel.action_label}
          </button>
        )}
      </div>

      {panel.judge_id !== undefined &&
        (runStatus === 'running' ? (
          <Skeleton className="h-4 w-64" />
        ) : linked !== undefined ? (
          <p
            className={`border-t border-slate-200 pt-3 text-xs ${flagged ? 'font-semibold text-red-600' : 'text-slate-500'}`}
          >
            Linked decision: {linked.question} → {formatAnswerValue(linked.answer)} ·{' '}
            {formatPercent(linked.confidence)} confident
            {flagged ? ' · below review bar — human handoff required' : ''}
          </p>
        ) : (
          <p className="border-t border-slate-200 pt-3 text-xs text-slate-400">
            No linked decision yet — run the workflow.
          </p>
        ))}
    </div>
  )
}
