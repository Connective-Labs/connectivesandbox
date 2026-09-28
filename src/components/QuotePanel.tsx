// Registry entry for dashboard panel type "quote_panel" (module wave 1):
// headline price band, itemised lines, basis footnote, status chip
// (draft/sent/accepted/expired). The itemised lines, basis, and status come
// from the spec (client-specific pricing rules are spec data, not module
// logic); the headline band is judge-accurate: with `band_judge_id` set, the
// band resolves from that decision's answer through the spec's `bands` map.
// Pricing by job characteristics, never a clock.

import type { DashboardPanel } from '@/engine/types'
import { formatAnswerValue } from '@/lib/format'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type QuotePanelPanel = Extract<DashboardPanel, { type: 'quote_panel' }>

const statusTone: Record<QuotePanelPanel['status'], string> = {
  draft: 'bg-amber-50 text-amber-700',
  sent: 'bg-accent-wash text-orange-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  expired: 'bg-slate-100 text-slate-500',
}

export default function QuotePanel({ panel }: { panel: QuotePanelPanel }) {
  const { decisions, runStatus } = useWorkspace()
  const bandRow =
    panel.band_judge_id !== undefined
      ? decisions.find((row) => row.judge_id === panel.band_judge_id)
      : undefined

  if (runStatus === 'running' && panel.band_judge_id !== undefined) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  const bandLabel =
    bandRow !== undefined
      ? (panel.bands?.find((entry) => entry.value === bandRow.answer)?.label ??
        formatAnswerValue(bandRow.answer))
      : undefined

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusTone[panel.status]}`}
        >
          {panel.status}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-slate-400">Price band</span>
        <span className="text-2xl font-bold tracking-tight tabular-nums text-ink">
          {bandLabel ?? '—'}
        </span>
      </div>
      {bandRow === undefined && panel.band_judge_id !== undefined && (
        <p className="text-sm text-slate-400">No quote yet — run the workflow.</p>
      )}

      <ul className="border-t border-slate-200">
        {panel.lines.map((line) => (
          <li
            key={line.label}
            className="flex items-center justify-between border-b border-slate-200 py-2.5 text-sm"
          >
            <span className="text-slate-700">
              {line.label}
              {line.quantity !== undefined && (
                <span className="ml-2 text-xs text-slate-400">× {line.quantity}</span>
              )}
            </span>
            <span className="font-semibold tabular-nums text-ink">{line.amount}</span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-slate-500">{panel.basis}</p>
    </div>
  )
}
