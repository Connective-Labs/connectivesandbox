// Registry entry for dashboard panel type "analysis": titled prose block with
// loading skeleton. The prose is the GLM-generated analysis returned by
// run-workflow; preview runs assemble it locally from the mock judge results.

import { useState } from 'react'

import type { DashboardPanel } from '@/engine/types'
import { formatAnswerValue, formatPercent } from '@/lib/format'
import { Skeleton } from '@/components/ui/Primitives'
import SpecText from '@/components/SpecText'
import { useWorkspace } from '@/state/workspace'

export type AnalysisPanel = Extract<DashboardPanel, { type: 'analysis' }>

export default function Analysis({ panel }: { panel: AnalysisPanel }) {
  const { spec, results, runStatus, analysis } = useWorkspace()
  const [expanded, setExpanded] = useState(false)

  if (runStatus === 'running') {
    return (
      <div className="space-y-2.5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    )
  }

  // LLM-sourced panels render the narration produced server-side by the
  // run-workflow gateway alongside the decision ledger.
  if (panel.source === 'llm' && analysis !== null && analysis.length > 0) {
    return (
      <div className="space-y-2">
        <h3 className="font-semibold tracking-tight text-ink"><SpecText value={panel.title} /></h3>
        <p className="text-sm leading-relaxed text-slate-600">{analysis}</p>
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="font-semibold tracking-tight text-ink"><SpecText value={panel.title} /></h3>
        <p className="text-sm text-slate-400">Run the workflow to generate analysis.</p>
      </div>
    )
  }

  const paragraphs = results.map((result) => {
    const judge = spec.judges.find((entry) => entry.id === result.judgeId)
    return {
      key: result.judgeId,
      question: judge?.question ?? result.judgeId,
      text: `${formatAnswerValue(result.answer.value)} at ${formatPercent(result.answer.confidence)} confidence (${result.disposition}).`,
    }
  })
  const clamped = !expanded && paragraphs.length > 2
  const visible = clamped ? paragraphs.slice(0, 2) : paragraphs

  return (
    <div className="space-y-2">
      <h3 className="font-semibold tracking-tight text-ink"><SpecText value={panel.title} /></h3>
      <div className="space-y-2 text-sm leading-relaxed text-slate-600">
        <p>
          {spec.judges.length} question{spec.judges.length === 1 ? '' : 's'}, {results.length} decision
          {results.length === 1 ? '' : 's'}.
        </p>
        {visible.map((entry) => (
          <p key={entry.key}>
            <span className="font-medium text-ink">{entry.question}</span> {entry.text}
          </p>
        ))}
        {clamped && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="font-medium text-accent transition hover:text-accent-hover"
          >
            Show more
          </button>
        )}
        {expanded && paragraphs.length > 2 && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="font-medium text-accent transition hover:text-accent-hover"
          >
            Show less
          </button>
        )}
      </div>
    </div>
  )
}
