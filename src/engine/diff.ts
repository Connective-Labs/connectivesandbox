// Spec diff — the plain-language summary of what changed between two
// WorkflowSpecs, shown when a new spec supersedes the current one (builder
// chat turns). Structural only: whole components/judges/panels by id, wording
// changes counted. Deterministic and pure.

import type { WorkflowSpec } from './types.ts'

interface Named {
  id: string
}

function diffIds(before: Named[], after: Named[]): { added: string[]; removed: string[] } {
  const beforeIds = new Set(before.map((entry) => entry.id))
  const afterIds = new Set(after.map((entry) => entry.id))
  return {
    added: after.filter((entry) => !beforeIds.has(entry.id)).map((entry) => entry.id),
    removed: before.filter((entry) => !afterIds.has(entry.id)).map((entry) => entry.id),
  }
}

const ID_LABELS: Record<string, string> = {
  decision_judge: 'the decision judge',
  escalation_judge: 'the escalation judge',
  quality_score: 'the quality judge',
  archetype_judge: 'the item-type judge',
  follow_up_judge: 'the follow-up judge',
  price_band_judge: 'the price-band judge',
  photo_slot: 'the photo slot',
  documents: 'the document upload',
  intake_chat: 'the chat intake',
  intake_form: 'the details form',
  follow_up: 'the follow-up card',
  request_kind: 'the request-kind picker',
  short_note: 'the note field',
  triage_verdict: 'the verdict card',
  quote: 'the quote panel',
  thread: 'the thread view',
  escalation: 'the escalation card',
  work_queue: 'the work queue',
  alerts: 'the alert feed',
  kpi_headline: 'the KPI tiles',
  pipeline: 'the stage tracker',
  summary: 'the summary panel',
  ops_metrics: 'the ops metrics',
  ownership_log: 'the decision log',
  runs: 'the run counter',
}

function label(id: string): string {
  return ID_LABELS[id] ?? id.replace(/_/g, ' ')
}

/** Human-readable list of structural changes, empty when nothing moved. */
export function specDiffSummary(before: WorkflowSpec, after: WorkflowSpec): string[] {
  const changes: string[] = []

  const intake = diffIds(before.intake.components, after.intake.components)
  for (const id of intake.added) changes.push(`added ${label(id)}`)
  for (const id of intake.removed) changes.push(`removed ${label(id)}`)

  const judges = diffIds(before.judges, after.judges)
  for (const id of judges.added) changes.push(`added ${label(id)}`)
  for (const id of judges.removed) changes.push(`removed ${label(id)}`)

  const panels = diffIds(before.dashboard.panels, after.dashboard.panels)
  for (const id of panels.added) changes.push(`added ${label(id)}`)
  for (const id of panels.removed) changes.push(`removed ${label(id)}`)

  // Threshold nudges on surviving judges.
  for (const judge of after.judges) {
    const previous = before.judges.find((entry) => entry.id === judge.id)
    if (previous === undefined) continue
    if (
      previous.thresholds.auto !== judge.thresholds.auto ||
      previous.thresholds.review !== judge.thresholds.review
    ) {
      changes.push(
        `adjusted ${label(judge.id)} thresholds (auto ${judge.thresholds.auto}, review ${judge.thresholds.review})`,
      )
    }
  }

  // Wording changes: count without noise.
  const wordingChanged =
    before.name !== after.name ||
    before.description !== after.description ||
    JSON.stringify(before.intake) !== JSON.stringify(after.intake) ||
    JSON.stringify(before.judges.map((judge) => judge.question)) !==
      JSON.stringify(after.judges.map((judge) => judge.question))
  if (wordingChanged && changes.length === 0) changes.push('updated the wording')
  else if (wordingChanged) changes.push('updated the wording')

  return changes
}
