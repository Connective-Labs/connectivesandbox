// Client workspace: ink top bar, collapsible 220px read-only workflow sidebar
// (icon rail by default, hover flyout, click pins open), and a main area —
// observability banner over a full-width surface when the dashboard is
// collapsed, 60/40 panes when expanded. Below tablet the panes stack with the
// dashboard first. One WorkspaceProvider wraps both panes so intake values
// and judge results are shared.

import { useEffect, useState } from 'react'
import { Layers, MessageSquare } from 'lucide-react'

import AppTopBar from '@/components/AppTopBar'
import WorkspaceBody from '@/components/workspace/WorkspaceBody'
import { FeedbackChat } from '@/components/workspace/FeedbackChat'
import { CollapsibleRail } from '@/components/ui/CollapsibleRail'
import { Eyebrow } from '@/components/ui/Primitives'
import { getWorkflowSpec, listWorkflows } from '@/data/adapters/workflows'
import type { WorkflowSummary } from '@/data/types'
import type { WorkflowSpec } from '@/engine/types'
import { WorkspaceProvider } from '@/state/workspace'
import { cn } from '@/lib/utils'

export default function Workspace() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [spec, setSpec] = useState<WorkflowSpec | null>(null)
  // Centre surface: the provisioned workflow (default) or the feedback
  // channel (service-team thread).
  const [surface, setSurface] = useState<'workflow' | 'feedback'>('workflow')

  useEffect(() => {
    let active = true
    void listWorkflows().then((summaries) => {
      if (!active) return
      setWorkflows(summaries)
      setSelectedId((current) => current ?? summaries[0]?.id ?? null)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    if (selectedId === null) {
      setSpec(null)
      return
    }
    void getWorkflowSpec(selectedId).then((loaded) => {
      if (active) setSpec(loaded)
    })
    return () => {
      active = false
    }
  }, [selectedId])

  const sidebarContent = (
    <>
      <div className="flex items-center justify-between gap-2 px-2 pr-10">
        <Eyebrow>Workflows</Eyebrow>
      </div>
      <nav aria-label="Provisioned workflows" className="space-y-1">
        {workflows.map((workflow) => (
          <button
            key={workflow.id}
            type="button"
            onClick={() => setSelectedId(workflow.id)}
            aria-current={workflow.id === selectedId ? 'page' : undefined}
            className={cn(
              'block w-full rounded-lg px-3 py-2.5 text-left transition-colors',
              workflow.id === selectedId
                ? 'bg-white text-ink shadow-sm ring-1 ring-slate-200'
                : 'text-slate-600 hover:bg-white/60 hover:text-ink',
            )}
          >
            <span
              className={cn(
                'block truncate text-sm font-medium',
                workflow.id === selectedId && 'text-accent',
              )}
            >
              {workflow.name}
            </span>
            <span className="mt-0.5 block truncate text-xs text-slate-400">
              v{workflow.version}
            </span>
          </button>
        ))}
      </nav>
    </>
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-white">
      <AppTopBar context="Workspace" />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <CollapsibleRail
          width={220}
          label="workflows"
          className="hidden border-r border-slate-200 bg-slate-50 md:block"
          rail={workflows.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => setSelectedId(workflow.id)}
              aria-label={workflow.name}
              title={workflow.name}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg transition',
                workflow.id === selectedId
                  ? 'bg-accent-tint text-accent'
                  : 'text-slate-400 hover:bg-white hover:text-ink',
              )}
            >
              <Layers size={16} aria-hidden="true" />
            </button>
          ))}
        >
          {sidebarContent}
        </CollapsibleRail>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {workflows.length > 1 && (
            <div className="border-b border-slate-200 px-4 py-2 md:hidden">
              <label htmlFor="workflow-switcher" className="sr-only">
                Choose workflow
              </label>
              <select
                id="workflow-switcher"
                value={selectedId ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              >
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Surface toggle: workflow (default) or the feedback channel. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-2">
            <div className="flex gap-1 rounded-full border border-slate-200 bg-white p-0.5">
              {(['workflow', 'feedback'] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setSurface(entry)}
                  aria-pressed={surface === entry}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-semibold transition-colors',
                    surface === entry ? 'bg-accent text-white shadow-sm' : 'text-slate-500 hover:text-ink',
                  )}
                >
                  {entry === 'workflow' ? (
                    <>
                      <Layers size={13} aria-hidden="true" /> Workflow
                    </>
                  ) : (
                    <>
                      <MessageSquare size={13} aria-hidden="true" /> Feedback
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>

          {surface === 'feedback' ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <FeedbackChat workflowId={selectedId} />
            </div>
          ) : spec !== null && selectedId !== null ? (
            <WorkspaceProvider key={spec.name} workflowId={selectedId} spec={spec} mode="live">
              <WorkspaceBody />
            </WorkspaceProvider>
          ) : (
            <p className="px-6 py-6 text-sm text-slate-400">Loading workflow…</p>
          )}
        </div>
      </div>
    </div>
  )
}
