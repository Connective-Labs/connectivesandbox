// Registry entry for dashboard panel type "usage_counter": runs this month,
// decisions made, estimated minutes saved. Every number traces to the
// decision ledger: the org totals are computed from `decisions` rows by the
// admin-api gateway, and local live runs add this session's decisions rows.
//
// Polish 6 redesign: a compact stat strip — small uppercase label over a
// tabular-numeral value with unit scaling (1.2k, 3.4M). The value can never
// overflow its tile at any viewport: compact units bound the glyph count and
// the strip truncates as a last resort.

import { useEffect, useState } from 'react'

import type { DashboardPanel } from '@/engine/types'
import { formatCountCompact } from '@/lib/format'
import { Skeleton, useGraceSkeleton } from '@/components/ui/Primitives'
import { getOrgUsageTotals, type OrgUsageTotals } from '@/data/adapters/clients'
import { useWorkspace } from '@/state/workspace'

export type UsageCounterPanel = Extract<DashboardPanel, { type: 'usage_counter' }>

// Product assumption: six minutes of manual work per judged decision.
const MINUTES_SAVED_PER_DECISION = 6

export default function UsageCounter({ panel }: { panel: UsageCounterPanel }) {
  const { decisions, runCount, mode } = useWorkspace()
  const [totals, setTotals] = useState<OrgUsageTotals | null>(null)
  // Skeleton discipline (polish 6): never flashes — a minimum ~300ms display.
  const showSkeleton = useGraceSkeleton(totals === null)

  useEffect(() => {
    let active = true
    void getOrgUsageTotals().then((result) => {
      if (active) setTotals(result)
    })
    return () => {
      active = false
    }
  }, [runCount])

  if (totals === null || showSkeleton) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-44" />
        <div className="grid grid-cols-3 gap-2">
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      </div>
    )
  }

  // Only live runs add on top of the ledger totals (preview runs are local
  // mock runs and never write decisions rows).
  const liveDecisions = mode === 'live' ? decisions.length : 0
  const liveRuns = mode === 'live' ? runCount : 0
  const decisionsMade = totals.decisionsMade + liveDecisions
  const stats = [
    { label: 'Runs this month', value: formatCountCompact(totals.runsThisMonth + liveRuns) },
    { label: 'Decisions made', value: formatCountCompact(decisionsMade) },
    {
      label: 'Est. minutes saved',
      value: formatCountCompact(decisionsMade * MINUTES_SAVED_PER_DECISION),
    },
  ]

  return (
    <div className="min-w-0 space-y-2">
      <h3 className="truncate font-semibold tracking-tight text-ink">{panel.label}</h3>
      <div className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0 border-slate-200 border-b bg-transparent px-0.5 pb-1">
            <p className="truncate text-[10px] font-semibold tracking-widest text-slate-400 uppercase" title={stat.label}>
              {stat.label}
            </p>
            <p
              className="mt-0.5 truncate text-base font-bold tabular-nums tracking-tight text-ink sm:text-lg"
              title={stat.value}
            >
              {stat.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
