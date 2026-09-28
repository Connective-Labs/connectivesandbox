// Headless verification for module waves 1 + 2 (run: node --experimental-strip-types scripts/verify-wave-modules.mts)
// 1. Registry coverage: every intake/dashboard type in the frozen unions has
//    a registry entry (runtime mirror of the compile-time Record check).
// 2. Both recipe demos (Clean Shades photo triage, Operations desk) validate
//    against the frozen Zod schema exactly as the builder's output would.
// 3. Every judge in both specs runs through the deterministic mock provider,
//    producing decisions-ledger rows, and every judge-bound panel finds its
//    row — i.e. the new modules populate from the ledger, nothing dangling.
import { readFileSync } from 'node:fs'

import { workflowSpecSchema } from '../src/engine/schema.ts'
import { runJudges } from '../src/engine/runner.ts'
import { mockJudgeProvider } from '../src/services/judge/mock.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// --- 1. Registry coverage -------------------------------------------------
const typesSource = readFileSync(new URL('../src/engine/types.ts', import.meta.url), 'utf8')
const registrySource = readFileSync(new URL('../src/engine/registry.ts', import.meta.url), 'utf8')

function unionMembers(unionName: string): string[] {
  const start = typesSource.indexOf(`type ${unionName} =`)
  const nextType = typesSource.indexOf('\ntype ', start + 1)
  const body = typesSource.slice(start, nextType === -1 ? undefined : nextType)
  return [...body.matchAll(/\{ type: '([a-z_]+)'/g)].map((match) => match[1])
}

const intakeTypes = unionMembers('IntakeComponent')
const panelTypes = unionMembers('DashboardPanel')
for (const type of intakeTypes) {
  check(`registry covers intake '${type}'`, new RegExp(`\\n  ${type}: lazyIntake`).test(registrySource))
}
for (const type of panelTypes) {
  check(`registry covers panel '${type}'`, new RegExp(`\\n  ${type}: lazyPanel`).test(registrySource))
}

// --- 2. Clean Shades photo-triage demo spec -------------------------------
const cleanShades = {
  name: 'Clean Shades photo-to-quote triage',
  description: 'Send a photo of the item; we judge sufficiency, ask one question, and price the job.',
  intake: {
    components: [
      { type: 'chat', id: 'chat', placeholder: 'Describe the job…', opening_message: "Send a photo of the item, like the customer's WhatsApp would." },
      { type: 'photo_slot', id: 'slot-curtain', label: 'Curtain photo', capture_hint: 'Include the rail in frame', accept: ['image/*'], key: 'curtain_photo' },
      { type: 'photo_slot', id: 'slot-carpet', label: 'Carpet photo', capture_hint: 'Show the full item on the floor', accept: ['image/*'], key: 'carpet_photo' },
      { type: 'follow_up_card', id: 'clarifier', label: 'Follow-up', question: 'Which one detail unblocks this job?', options: [
        { value: 'rail_in_frame', label: 'Rail in frame' },
        { value: 'doorway_shot', label: 'Doorway shot' },
        { value: 'rail_width', label: 'Rail width' },
        { value: 'fabric_tag', label: 'Fabric tag' },
      ], allow_text: true },
    ],
  },
  judges: [
    { id: 'legibility', state_from: ['curtain_photo', 'carpet_photo'], question: 'Is the enquiry quotable as-is?', question_type: 'choice', options: ['quotable', 'one_ask', 'site_visit', 'cannot_assess'], thresholds: { auto: 0.85, review: 0.5 } },
    { id: 'archetype', state_from: ['curtain_photo', 'carpet_photo'], question: 'What item archetype is it?', question_type: 'choice', options: ['curtain', 'blind', 'carpet', 'rug', 'sofa', 'mattress', 'mixed'], thresholds: { auto: 0.9, review: 0.5 } },
    { id: 'follow-up', state_from: ['curtain_photo', 'carpet_photo'], question: 'Which pre-authored ask unblocks the job?', question_type: 'choice', options: ['rail_in_frame', 'doorway_shot', 'rail_width', 'fabric_tag', 'other'], thresholds: { auto: 0.9, review: 0.5 } },
    { id: 'price-band', state_from: ['curtain_photo', 'carpet_photo', 'clarifier'], question: 'Which price band does the job fall in?', question_type: 'choice', options: ['band_a', 'band_b', 'band_c', 'needs_visit'], thresholds: { auto: 0.9, review: 0.5 } },
  ],
  dashboard: {
    panels: [
      { type: 'triage_verdict', id: 'verdict', judge_id: 'legibility', verdicts: [
        { value: 'quotable', label: 'QUOTABLE' },
        { value: 'one_ask', label: 'ONE-ASK' },
        { value: 'site_visit', label: 'SITE VISIT' },
        { value: 'cannot_assess', label: 'CANNOT ASSESS' },
      ], follow_up_judge_id: 'follow-up' },
      { type: 'quote_panel', id: 'quote', title: 'Draft quote', lines: [
        { label: 'Curtain, black-out', quantity: 2, amount: 'S$120–S$170' },
        { label: 'Carpet, living room', quantity: 1, amount: 'S$60–S$90' },
      ], basis: 'Basis: job characteristics, not hours. Valid 14 days.', status: 'draft', band_judge_id: 'price-band', bands: [
        { value: 'band_a', label: 'S$120–S$180' },
        { value: 'band_b', label: 'S$180–S$260' },
        { value: 'band_c', label: 'S$260–S$400' },
        { value: 'needs_visit', label: 'Site visit required' },
      ] },
      { type: 'thread_preview', id: 'thread', title: 'Joined thread', photo_slot_key: 'curtain_photo', follow_up_judge_id: 'follow-up', quote_judge_id: 'price-band' },
      { type: 'escalation_card', id: 'escalation', contact: 'Leon', reason: 'unclear photo (cannot assess)', reference: 'Thread #CS-1042', action_label: 'Send to Leon', judge_id: 'legibility' },
      { type: 'confidence_meter', id: 'cm-legibility', judge_id: 'legibility', label: 'Legibility confidence' },
      { type: 'decision_log', id: 'log', limit: 10 },
      { type: 'usage_counter', id: 'usage', label: 'Workflow runs' },
    ],
  },
}

// --- 3. Operations desk demo spec ------------------------------------------
const operationsDesk = {
  name: 'LiT operations desk',
  description: 'One omnichannel desk: orders and tickets in a queue, alerts, and two buttons.',
  intake: {
    components: [
      { type: 'chat', id: 'chat', placeholder: "Describe the problem like you'd WhatsApp it…", opening_message: 'What needs handling today — a ticket or an order?' },
      { type: 'form', id: 'details', fields: [
        { id: 'affected', label: 'Affected person or SKU', type: 'text', required: true },
        { id: 'office', label: 'Office', type: 'select', required: true, options: [
          { value: 'sg', label: 'Singapore' },
          { value: 'my', label: 'Malaysia' },
          { value: 'vn', label: 'Vietnam' },
        ] },
        { id: 'device', label: 'Device or channel', type: 'text' },
      ] },
    ],
  },
  judges: [
    { id: 'severity', state_from: ['chat', 'details'], question: 'How severe is the item?', question_type: 'choice', options: ['low', 'medium', 'high', 'blocker'], thresholds: { auto: 0.9, review: 0.5 } },
    { id: 'category', state_from: ['chat', 'details'], question: 'What category is it?', question_type: 'choice', options: ['email', 'access', 'device', 'network', 'software', 'order', 'other'], thresholds: { auto: 0.9, review: 0.5 } },
    { id: 'route', state_from: ['chat', 'details'], question: 'How should it be handled?', question_type: 'choice', options: ['self_serve', 'automated', 'human_escalate'], thresholds: { auto: 0.9, review: 0.5 } },
    { id: 'stage', state_from: ['details'], question: 'Which stage is the order at?', question_type: 'choice', options: ['order', 'packed', 'dispatched'], thresholds: { auto: 0.9, review: 0.5 } },
  ],
  dashboard: {
    panels: [
      { type: 'status_queue', id: 'queue', title: 'Omnichannel queue', rows: [
        { id: '#4821', label: 'SKU 4821, 3 units', source: 'Shopify', severity: 'high', state: 'awaiting stock' },
        { id: '#4817', label: 'Duvet set, 1 unit', source: 'Shopee', severity: 'medium', state: 'packed' },
        { id: 'IT-114', label: 'Email not syncing, SG office', source: 'WhatsApp', severity: 'high', state: 'open' },
        { id: '#4809', label: 'Curtain panel, 2 units', source: 'Lazada', severity: 'low', state: 'ready' },
      ], actions: [
        { value: 'fulfil', label: 'Fulfil', primary: true },
        { value: 'not_yet', label: 'Not yet', primary: false },
      ] },
      { type: 'alert_feed', id: 'alerts', title: 'Alerts', alerts: [
        { id: 'a1', title: 'Oversell risk: SKU 4821', source: 'Shopify vs warehouse count', age_days: 2, severity: 'high' },
        { id: 'a2', title: 'Quotation expired', source: 'QT-2291 · Firestone Pte Ltd', age_days: 34, severity: 'medium' },
        { id: 'a3', title: 'Payment overdue', source: 'INV-3310 · S$4,120', age_days: 92, severity: 'medium' },
      ], action_label: 'Review', critical_after_days: 30 },
      { type: 'kpi_tiles', id: 'kpis', title: 'Today', metrics: [
        { label: 'Decisions today', metric: 'decisions_total', delta: { direction: 'up', text: '6 vs yesterday' } },
        { label: 'Auto-handled', metric: 'auto_rate' },
        { label: 'Escalated', metric: 'escalation_rate' },
      ] },
      { type: 'pipeline_tracker', id: 'pipeline', title: 'Order pipeline', stages: [
        { label: 'Order', count: 128 },
        { label: 'Packed', count: 96 },
        { label: 'Dispatched', count: 41 },
      ], current_judge_id: 'stage' },
      { type: 'escalation_card', id: 'escalation', contact: 'Leddin', reason: 'human escalation route', reference: 'Queue IT-114', action_label: 'Send to Leddin', judge_id: 'route' },
      { type: 'decision_log', id: 'log', limit: 10 },
      { type: 'usage_counter', id: 'usage', label: 'Workflow runs' },
    ],
  },
}

for (const [name, spec] of [['Clean Shades photo triage', cleanShades], ['Operations desk', operationsDesk]] as const) {
  const parsed = workflowSpecSchema.safeParse(spec)
  check(`${name} spec validates against the frozen schema`, parsed.success,
    parsed.success ? '' : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  if (!parsed.success) continue

  // Intake state as the renderers would produce it: photo files land under
  // the spec's judge-state key, the clarifier answer under the component id.
  const intakeState = {
    curtain_photo: [],
    carpet_photo: [],
    clarifier: 'rail_in_frame',
    chat: 'Curtain and carpet for the living room, photos attached.',
    details: { affected: 'SKU 4821', office: 'sg', device: 'Shopify' },
  }
  const run = await runJudges(parsed.data, intakeState, mockJudgeProvider)
  const ledger = run.results.map((result) => ({
    judge_id: result.judgeId,
    answer: result.answer.value,
    confidence: result.answer.confidence,
    disposition: result.disposition,
  }))
  check(`${name}: every judge produced a ledger row`, ledger.length === parsed.data.judges.length,
    `expected ${parsed.data.judges.length}, got ${ledger.length}`)
  check(`${name}: every judge answer is closed-set`, ledger.every((row) => typeof row.answer === 'string' || typeof row.answer === 'number' || typeof row.answer === 'boolean'))

  // Every judge-bound dashboard panel finds its decision row in the ledger.
  const judgeIds = new Set(ledger.map((row) => row.judge_id))
  const bound: string[] = []
  for (const panel of parsed.data.dashboard.panels) {
    if ('judge_id' in panel && panel.judge_id !== undefined) bound.push(panel.judge_id)
    if ('band_judge_id' in panel && panel.band_judge_id !== undefined) bound.push(panel.band_judge_id)
    if ('follow_up_judge_id' in panel && panel.follow_up_judge_id !== undefined) bound.push(panel.follow_up_judge_id)
    if ('quote_judge_id' in panel && panel.quote_judge_id !== undefined) bound.push(panel.quote_judge_id)
    if ('current_judge_id' in panel && panel.current_judge_id !== undefined) bound.push(panel.current_judge_id)
  }
  const dangling = bound.filter((judgeId) => !judgeIds.has(judgeId))
  check(`${name}: every judge-bound panel has its ledger row (bound: ${bound.join(', ')})`, dangling.length === 0,
    `dangling: ${dangling.join(', ')}`)

  // The wave modules' judge bindings resolve to ledger answers.
  const answerFor = (judgeId: string) => ledger.find((row) => row.judge_id === judgeId)?.answer
  const verdict = parsed.data.dashboard.panels.find((panel) => panel.type === 'triage_verdict')
  if (verdict !== undefined && verdict.type === 'triage_verdict') {
    const value = answerFor(verdict.judge_id)
    check(`${name}: triage_verdict maps ledger answer '${String(value)}' to a label`,
      verdict.verdicts.some((entry) => entry.value === value))
  }
  const quote = parsed.data.dashboard.panels.find((panel) => panel.type === 'quote_panel')
  if (quote !== undefined && quote.type === 'quote_panel' && quote.band_judge_id !== undefined) {
    const value = answerFor(quote.band_judge_id)
    check(`${name}: quote_panel maps ledger answer '${String(value)}' to a price band`,
      (quote.bands ?? []).some((entry) => entry.value === value))
  }
  const pipeline = parsed.data.dashboard.panels.find((panel) => panel.type === 'pipeline_tracker')
  if (pipeline !== undefined && pipeline.type === 'pipeline_tracker' && pipeline.current_judge_id !== undefined) {
    const value = String(answerFor(pipeline.current_judge_id))
    check(`${name}: pipeline_tracker resolves current stage '${value}' from the ledger`,
      pipeline.stages.some((stage) => stage.label.toLowerCase() === value.toLowerCase()))
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
