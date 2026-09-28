// Ledger metric derivation shared by the monitoring panel and kpi_tiles.
// Every value traces to the decision ledger (the workspace's `decisions`
// rows, straight from the `decisions` table) — a number that cannot be
// traced to decisions is a bug. Unknown metric names fall back to the
// ledger's decision count so no tile can show an invented number.

export interface MetricValue {
  label: string
  value: string
}

export function deriveMetric(
  name: string,
  decisions: { confidence: number; disposition: string }[],
): MetricValue {
  const label = name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
  const total = decisions.length
  if (total === 0) return { label, value: '—' }
  switch (name) {
    case 'average_confidence':
    case 'mean_confidence': {
      const mean = decisions.reduce((sum, row) => sum + row.confidence, 0) / total
      return { label, value: formatPercent(mean) }
    }
    case 'review_rate': {
      const inReview = decisions.filter((row) => row.disposition === 'review').length
      return { label, value: formatPercent(inReview / total) }
    }
    case 'escalation_rate': {
      const escalated = decisions.filter((row) => row.disposition === 'escalated').length
      return { label, value: formatPercent(escalated / total) }
    }
    case 'auto_rate':
    case 'auto_decision_rate': {
      const auto = decisions.filter((row) => row.disposition === 'auto').length
      return { label, value: formatPercent(auto / total) }
    }
    case 'documents_processed':
    case 'visits_booked':
    case 'decisions_total':
    case 'decisions_made':
    default:
      // Unknown metric names fall back to the ledger's decision count.
      return { label, value: formatCountCompact(total) }
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatCountCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(value)
}
