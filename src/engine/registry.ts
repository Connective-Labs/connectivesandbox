// Fixed component registry: maps the component/panel type strings that can
// appear in a validated WorkflowSpec to React components. No model emits UI
// at runtime — the spec is data, this map is code.
//
// Phase 1: every entry points at a typed placeholder component so the map is
// complete and type-checked. Phase 3 fills in behaviour behind the same keys.

import { lazy, type ComponentType } from 'react'

import type { DashboardPanel, IntakeComponent } from './types'

/** Props every intake renderer receives; implementations narrow internally. */
export interface IntakeComponentViewProps {
  component: IntakeComponent
  disabled?: boolean
  /** 'panel' (standalone card, default) or 'inline' (compact card inside the chat flow). */
  variant?: 'panel' | 'inline'
  /** Inline file pickers: hand files to the chat's attachment tray, tagged with the component id. */
  onFiles?: (files: File[], sourceId: string) => void
  /** Inline card submission: posts the answer into the chat flow like a message. */
  onSubmitted?: (summary: string) => void
}

/** Props every dashboard panel renderer receives; implementations narrow internally. */
export interface DashboardPanelViewProps {
  panel: DashboardPanel
}

type IntakeRegistry = Record<IntakeComponent['type'], ComponentType<IntakeComponentViewProps>>
type DashboardRegistry = Record<DashboardPanel['type'], ComponentType<DashboardPanelViewProps>>

// Each placeholder's props are narrower than the registry entry (they take the
// matching variant), so the lazy import is cast through unknown at the registry
// boundary. Phase 3 keeps the same keys and props contract.
function lazyIntake<P extends IntakeComponentViewProps>(
  loader: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<IntakeComponentViewProps> {
  return lazy(loader) as unknown as ComponentType<IntakeComponentViewProps>
}

function lazyPanel<P extends DashboardPanelViewProps>(
  loader: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<DashboardPanelViewProps> {
  return lazy(loader) as unknown as ComponentType<DashboardPanelViewProps>
}

export const intakeRegistry: IntakeRegistry = {
  file_upload: lazyIntake(() => import('@/components/FileUpload')),
  // The chat flow renders itself (IntakeSurface mounts Chat directly so the
  // one flow can carry the other intake components as inline cards); the
  // registry entry stays complete for spec coverage.
  chat: lazyIntake(async () => {
    const mod = await import('@/components/Chat')
    return { default: mod.default as unknown as ComponentType<IntakeComponentViewProps> }
  }),
  button_group: lazyIntake(() => import('@/components/ButtonGroup')),
  text_field: lazyIntake(() => import('@/components/TextField')),
  form: lazyIntake(() => import('@/components/Form')),
  photo_slot: lazyIntake(() => import('@/components/PhotoSlot')),
  follow_up_card: lazyIntake(() => import('@/components/FollowUpCard')),
}

export const dashboardRegistry: DashboardRegistry = {
  confidence_meter: lazyPanel(() => import('@/components/ConfidenceMeter')),
  analysis: lazyPanel(() => import('@/components/Analysis')),
  monitoring: lazyPanel(() => import('@/components/Monitoring')),
  decision_log: lazyPanel(() => import('@/components/DecisionLog')),
  usage_counter: lazyPanel(() => import('@/components/UsageCounter')),
  triage_verdict: lazyPanel(() => import('@/components/TriageVerdict')),
  quote_panel: lazyPanel(() => import('@/components/QuotePanel')),
  escalation_card: lazyPanel(() => import('@/components/EscalationCard')),
  thread_preview: lazyPanel(() => import('@/components/ThreadPreview')),
  status_queue: lazyPanel(() => import('@/components/StatusQueue')),
  alert_feed: lazyPanel(() => import('@/components/AlertFeed')),
  kpi_tiles: lazyPanel(() => import('@/components/KpiTiles')),
  pipeline_tracker: lazyPanel(() => import('@/components/PipelineTracker')),
}

/** Every intake type string the registry knows about. */
export const intakeComponentTypes = Object.keys(intakeRegistry) as IntakeComponent['type'][]

/** Every dashboard panel type string the registry knows about. */
export const dashboardPanelTypes = Object.keys(dashboardRegistry) as DashboardPanel['type'][]
