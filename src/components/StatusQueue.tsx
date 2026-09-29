// Registry entry for dashboard panel type "status_queue" (module wave 2 —
// LiT operations desk): sortable/filterable rows with severity colour, state
// chips, and EXACTLY two per-row action buttons from the spec — the "one
// button to say yes, one button to not yet" shape. Rows are spec data (in
// demos the queue represents the records; live feeds are a backend phase).
// An action tap moves the row's state chip (demo-surface actuation); the
// ledger relationship is documented, never faked.

import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { DashboardPanel } from '@/engine/types'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type StatusQueuePanel = Extract<DashboardPanel, { type: 'status_queue' }>

type Severity = StatusQueuePanel['rows'][number]['severity']

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

const severityChip: Record<Severity, string> = {
  high: 'bg-red-50 text-red-600',
  medium: 'bg-amber-50 text-amber-700',
  low: 'bg-emerald-50 text-emerald-700',
}

const severityDot: Record<Severity, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-emerald-500',
}

const FILTERS: ('all' | Severity)[] = ['all', 'high', 'medium', 'low']

export default function StatusQueue({ panel }: { panel: StatusQueuePanel }) {
  const { runStatus } = useWorkspace()
  // Row id -> action value tapped; a tap moves that row's state chip.
  const [acted, setActed] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<'all' | Severity>('all')
  const [severityAsc, setSeverityAsc] = useState(false)

  const rows = useMemo(() => {
    const filtered = panel.rows.filter((row) => filter === 'all' || row.severity === filter)
    return [...filtered].sort((a, b) =>
      severityAsc
        ? SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        : SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    )
  }, [panel.rows, filter, severityAsc])

  if (runStatus === 'running') {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  if (panel.rows.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
        <p className="text-sm text-slate-400">Queue is empty — nothing waiting.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
        <div role="group" aria-label="Filter by severity" className="flex gap-1">
          {FILTERS.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setFilter(entry)}
              aria-pressed={filter === entry}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                filter === entry
                  ? 'bg-ink text-white'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-ink',
              )}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <th scope="col" className="py-2 pr-3 font-medium">Item</th>
              <th scope="col" className="py-2 pr-3 font-medium">Source</th>
              <th scope="col" className="py-2 pr-3 font-medium">
                <button
                  type="button"
                  onClick={() => setSeverityAsc((previous) => !previous)}
                  className="uppercase tracking-wide hover:text-ink"
                  aria-label={`Sort by severity, currently ${severityAsc ? 'low first' : 'high first'}`}
                >
                  Severity {severityAsc ? '↑' : '↓'}
                </button>
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">State</th>
              <th scope="col" className="py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = acted[row.id] ?? row.state
              const actedOn = acted[row.id] !== undefined
              return (
                <tr key={row.id} className={cn('border-b border-slate-100 last:border-0', actedOn && 'opacity-60')}>
                  <td className="py-2.5 pr-3">
                    <span aria-hidden="true" className={cn('mr-2 inline-block h-2 w-2 rounded-full', severityDot[row.severity])} />
                    <span className="font-semibold text-ink">{row.id}</span>{' '}
                    <span className="text-xs text-slate-500">{row.label}</span>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-slate-500">{row.source}</td>
                  <td className="py-2.5 pr-3">
                    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize', severityChip[row.severity])}>
                      {row.severity}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={state}
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -3 }}
                        transition={{ duration: 0.16, ease: 'easeOut' }}
                        className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', actedOn ? 'bg-accent-wash text-orange-700' : 'bg-slate-100 text-slate-600')}
                      >
                        {state}
                      </motion.span>
                    </AnimatePresence>
                  </td>
                  <td className="py-2.5">
                    <div className="flex justify-end gap-1.5">
                      {panel.actions.map((action) => (
                        <button
                          key={action.value}
                          type="button"
                          onClick={() => setActed((previous) => ({ ...previous, [row.id]: action.label }))}
                          disabled={actedOn}
                          className={cn(
                            'rounded-full px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
                            action.primary
                              ? 'bg-accent text-white hover:bg-accent-hover'
                              : 'border border-slate-200 bg-white text-slate-600 hover:border-accent hover:text-accent',
                          )}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
