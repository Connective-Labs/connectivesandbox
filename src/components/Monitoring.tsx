// Registry entry for dashboard panel type "monitoring": compact metric tiles
// in a fixed grid — tabular numerals, compact units, labels truncate with a
// tooltip. Every value is derived from the decision ledger (the workspace's
// decisions rows, which come straight from the `decisions` table) — a number
// that cannot be traced to decisions is a bug.

import type { DashboardPanel } from '@/engine/types'
import { deriveMetric } from '@/lib/metrics'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type MonitoringPanel = Extract<DashboardPanel, { type: 'monitoring' }>

export default function Monitoring({ panel }: { panel: MonitoringPanel }) {
  const { decisions, runStatus } = useWorkspace()

  if (runStatus === 'running') {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-28" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {panel.metrics.map((metric) => (
            <Skeleton key={metric} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <h3 className="font-semibold tracking-tight text-ink">Monitoring</h3>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {panel.metrics.map((metric) => {
          const derived = deriveMetric(metric, decisions)
          return (
            <div
              key={metric}
              className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-2.5"
            >
              <p className="truncate text-xs font-medium text-slate-400" title={derived.label}>
                {derived.label}
              </p>
              <p
                className="mt-0.5 truncate text-lg font-bold tabular-nums tracking-tight text-ink sm:text-xl"
                title={derived.value}
              >
                {derived.value}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
