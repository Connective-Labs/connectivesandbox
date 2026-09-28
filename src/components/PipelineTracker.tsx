// Registry entry for dashboard panel type "pipeline_tracker" (module wave 2 —
// operations desk): horizontal stage chips (done / current / pending) with a
// count badge per stage — the Firetronics "quotation → PO → DO → invoice →
// payment" billing pipeline shape. Stages and counts come from the spec; the
// current stage is judge-accurate: with `current_judge_id` set, the ledger's
// answer names the stage (matched case/underscore-insensitively), otherwise
// the spec's `current` fallback applies. Everything before the current stage
// is done, everything after is pending.

import type { DashboardPanel } from '@/engine/types'
import { formatCount, humaniseValue } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type PipelineTrackerPanel = Extract<DashboardPanel, { type: 'pipeline_tracker' }>

export default function PipelineTracker({ panel }: { panel: PipelineTrackerPanel }) {
  const { decisions, runStatus } = useWorkspace()
  const currentRow =
    panel.current_judge_id !== undefined
      ? decisions.find((row) => row.judge_id === panel.current_judge_id)
      : undefined

  const currentLabel =
    currentRow !== undefined
      ? humaniseValue(String(currentRow.answer)).toLowerCase()
      : panel.current !== undefined
        ? panel.current.toLowerCase()
        : undefined

  const currentIndex = (() => {
    if (currentLabel === undefined) return -1
    const normalise = (value: string) => value.replace(/[\s_-]+/g, ' ').trim()
    return panel.stages.findIndex((stage) => normalise(stage.label.toLowerCase()) === normalise(currentLabel))
  })()

  const stageState = (index: number): 'done' | 'current' | 'pending' => {
    if (currentIndex === -1) return 'pending'
    if (index < currentIndex) return 'done'
    if (index === currentIndex) return 'current'
    return 'pending'
  }

  if (runStatus === 'running' && panel.current_judge_id !== undefined) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-36" />
        <div className="flex gap-2">
          {panel.stages.map((stage) => (
            <Skeleton key={stage.label} className="h-9 w-24 rounded-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
      {panel.current_judge_id !== undefined && currentRow === undefined && (
        <p className="text-sm text-slate-400">
          Awaiting the first run — stages light up from the decision ledger.
        </p>
      )}
      {currentIndex === -1 && panel.current_judge_id === undefined && panel.current !== undefined && (
        <p className="text-xs text-slate-400">Stage "{panel.current}" not found in the stage list.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {panel.stages.map((stage, index) => {
          const state = stageState(index)
          return (
            <div key={stage.label} className="contents">
              {index > 0 && (
                <span aria-hidden="true" className="text-slate-300">
                  →
                </span>
              )}
              <div className="text-center">
                <span
                  className={cn(
                    'inline-block rounded-full px-3.5 py-1.5 text-xs font-semibold',
                    state === 'done' && 'bg-emerald-50 text-emerald-700',
                    state === 'current' && 'bg-accent text-white shadow-sm',
                    state === 'pending' && 'bg-slate-100 text-slate-500',
                  )}
                >
                  {stage.label}
                </span>
                {stage.count !== undefined && (
                  <p className="mt-1 text-[11px] tabular-nums text-slate-500">
                    {formatCount(stage.count)}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
