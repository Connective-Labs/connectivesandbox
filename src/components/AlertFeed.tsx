// Registry entry for dashboard panel type "alert_feed" (module wave 2 —
// operations desk): ranked alert cards with severity colour, source record,
// age, and one deep-link action button — the Firetronics "AI alerts for
// missed maintenance, unusual patterns, and expiring quotations" surface.
// `critical_after_days` is the spec's threshold: an alert older than it
// displays as critical regardless of its base severity. Ranking: severity
// first (high > medium > low), then age (oldest first). Alerts are spec data
// in the demo; live threshold feeds are a backend phase.

import { useMemo, useState } from 'react'
import type { DashboardPanel } from '@/engine/types'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type AlertFeedPanel = Extract<DashboardPanel, { type: 'alert_feed' }>

type Severity = AlertFeedPanel['alerts'][number]['severity']

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

const barTone: Record<Severity, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-emerald-500',
}

const chipTone: Record<Severity, string> = {
  high: 'bg-red-50 text-red-600',
  medium: 'bg-amber-50 text-amber-700',
  low: 'bg-emerald-50 text-emerald-700',
}

export default function AlertFeed({ panel }: { panel: AlertFeedPanel }) {
  const { runStatus } = useWorkspace()
  const [handled, setHandled] = useState<Record<string, boolean>>({})

  const ranked = useMemo(() => {
    return [...panel.alerts]
      .map((alert) => ({
        ...alert,
        shown: (panel.critical_after_days !== undefined && alert.age_days >= panel.critical_after_days
          ? 'high'
          : alert.severity) as Severity,
      }))
      .sort((a, b) => SEVERITY_RANK[a.shown] - SEVERITY_RANK[b.shown] || b.age_days - a.age_days)
  }, [panel.alerts, panel.critical_after_days])

  if (runStatus === 'running') {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    )
  }

  if (panel.alerts.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
        <p className="text-sm text-slate-400">No alerts — nothing needs chasing.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
      <div className="flex max-w-2xl flex-col gap-2.5">
        {ranked.map((alert) => (
          <div
            key={alert.id}
            className={cn(
              'flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 pr-3.5',
              handled[alert.id] && 'opacity-55',
            )}
          >
            <span aria-hidden="true" className={cn('w-1 self-stretch rounded-full', barTone[alert.shown])} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{alert.title}</p>
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {alert.source} · {alert.age_days} {alert.age_days === 1 ? 'day' : 'days'} old
              </p>
            </div>
            <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize', chipTone[alert.shown])}>
              {alert.shown}
            </span>
            {handled[alert.id] ? (
              <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                Handled
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setHandled((previous) => ({ ...previous, [alert.id]: true }))}
                className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-accent hover:text-accent"
              >
                {panel.action_label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
