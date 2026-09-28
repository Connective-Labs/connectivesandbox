// Registry entry for dashboard panel type "kpi_tiles" (module wave 2 —
// operations desk): 2–4 numeric headline tiles with tabular numerals and
// optional spec-supplied delta arrows. Every value derives from the decision
// ledger via the shared metric helper — unknown metric names fall back to
// the decision count (the same rule as monitoring), so no tile can show a
// number that did not come from decisions.

import type { DashboardPanel } from '@/engine/types'
import { deriveMetric } from '@/lib/metrics'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type KpiTilesPanel = Extract<DashboardPanel, { type: 'kpi_tiles' }>

const deltaTone: Record<'up' | 'down' | 'flat', string> = {
  up: 'text-emerald-600',
  down: 'text-red-600',
  flat: 'text-slate-500',
}

const deltaArrow: Record<'up' | 'down' | 'flat', string> = {
  up: '▲',
  down: '▼',
  flat: '—',
}

export default function KpiTiles({ panel }: { panel: KpiTilesPanel }) {
  const { decisions, runStatus } = useWorkspace()

  if (runStatus === 'running') {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-28" />
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {panel.metrics.map((metric) => (
            <Skeleton key={metric.label} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
      <div
        className={cn(
          'grid gap-2.5',
          panel.metrics.length === 2 && 'grid-cols-2',
          panel.metrics.length === 3 && 'grid-cols-2 sm:grid-cols-3',
          panel.metrics.length >= 4 && 'grid-cols-2 lg:grid-cols-4',
        )}
      >
        {panel.metrics.map((metric) => {
          const derived = deriveMetric(metric.metric, decisions)
          return (
            <div
              key={metric.label}
              className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white p-3.5"
            >
              <p className="truncate text-xs font-semibold text-slate-500" title={metric.label}>
                {metric.label}
              </p>
              <p
                className="mt-1 truncate text-2xl font-bold tabular-nums tracking-tight text-ink"
                title={derived.value}
              >
                {derived.value}
              </p>
              {metric.delta !== undefined && (
                <p className={cn('mt-1 text-xs font-semibold', deltaTone[metric.delta.direction])}>
                  {deltaArrow[metric.delta.direction]} {metric.delta.text}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
