// Pure verification of the builder-chat spec path and the feedback planner's
// deterministic applier (headless, no network, no secrets).
//
// Asserts:
//   1. extractSpecJson — fenced blocks, bare objects, last-block-wins,
//      brace-containing prose, string-aware brace scanning, no-JSON → null;
//   2. validateSpec — valid specs pass, schema violations surface the issue,
//      malformed JSON reports cleanly;
//   3. applyProposal — wave-module panel adds, wave string rewording,
//      threshold clamping, always-on panels, last-intake protection, and the
//      no-mutation guarantee (the input spec is never modified in place).
//
// Run: node scripts/verify-builder-spec.mjs

import { strict as assert } from 'node:assert'

import { extractSpecJson, validateSpec } from '../supabase/functions/_shared/spec-validate.ts'
import { applyProposal, stringSlots } from '../supabase/functions/_shared/planner.ts'
import { compileSpec } from '../src/engine/compilers.ts'
import { applyFacts } from '../src/engine/facts.ts'

let passed = 0
const ok = (name) => {
  passed += 1
  console.log(`ok: ${name}`)
}

// ---------------------------------------------------------------------------
// 1. extractSpecJson
// ---------------------------------------------------------------------------
{
  const fenced = 'Here is the workflow:\n```json\n{"name":"Photo triage"}\n```\nHope that helps.'
  assert.equal(extractSpecJson(fenced), '{"name":"Photo triage"}')
  const unfenced = '```json\nnot json but fenced\n```'
  assert.equal(extractSpecJson(unfenced), null)
  const bare = 'The spec is {"name":"X","description":"d"} as requested.'
  assert.equal(extractSpecJson(bare), '{"name":"X","description":"d"}')
  const lastWins = '```\n{"name":"first"}\n```\n```\n{"name":"second"}\n```'
  assert.equal(extractSpecJson(lastWins), '{"name":"second"}')
  const bracesInProse = 'The spec {"a":1} ships today — brace-lookalikes like } follow.'
  assert.equal(extractSpecJson(bracesInProse), '{"a":1}')
  const stringsWithBraces = '{"q":"what about } braces?"}'
  assert.deepEqual(JSON.parse(extractSpecJson(stringsWithBraces)), { q: 'what about } braces?' })
  assert.equal(extractSpecJson('no structured output here'), null)
  ok('extractSpecJson: fenced, bare, last-block-wins, prose braces, string-aware, null')
}

// ---------------------------------------------------------------------------
// 2. validateSpec
// ---------------------------------------------------------------------------
{
  const valid = JSON.stringify(compileSpec('photo-triage', applyFacts([])))
  const result = validateSpec(valid)
  assert.ok(result.ok, 'a compiled spec validates')
  const invalid = JSON.stringify({ name: 'X', description: 'd', intake: { components: [] }, judges: 'nope', dashboard: { panels: [] } })
  const bad = validateSpec(invalid)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /judges/, 'schema violations name the failing path')
  const malformed = validateSpec('{"name": ')
  assert.equal(malformed.ok, false)
  assert.match(malformed.error, /not valid JSON/)
  ok('validateSpec: valid, path-naming failure, malformed JSON')
}

// ---------------------------------------------------------------------------
// 3. applyProposal — deterministic, bounded, non-mutating
// ---------------------------------------------------------------------------
const baseline = compileSpec('photo-triage', applyFacts([]))
{
  const proposal = {
    strings: { name: 'Clean Shades triage' },
    componentOps: [{ op: 'add', component: 'kpi_tiles' }],
    thresholdTweaks: [],
    summary: '',
  }
  const before = JSON.stringify(baseline)
  const { spec, applied } = applyProposal(baseline, proposal)
  assert.equal(JSON.stringify(baseline), before, 'the input spec is never mutated')
  assert.equal(spec.name, 'Clean Shades triage')
  assert.ok(spec.dashboard.panels.some((panel) => panel.type === 'kpi_tiles'), 'kpi_tiles added')
  assert.ok(applied.some((entry) => entry.includes('kpi tiles')), 'plain-language diff names the add')
  ok('applyProposal: panel add + rename, input untouched')
}
{
  // Wave string slots are rewordable (photo_slot capture_hint, escalation reason).
  const slots = stringSlots(baseline)
  assert.ok(slots.has('intake.components.photo_slot.capture_hint'), 'photo_slot capture_hint is offered')
  assert.ok(slots.has('dashboard.panels.escalation.reason'), 'escalation reason is offered')
  const { spec } = applyProposal(baseline, {
    strings: {
      'intake.components.photo_slot.capture_hint': 'Include the rail in frame',
      'dashboard.panels.escalation.reason': 'Blurry photos go to Leon first.',
    },
    componentOps: [],
    thresholdTweaks: [],
    summary: '',
  })
  const photo = spec.intake.components.find((component) => component.id === 'photo_slot')
  assert.equal(photo.capture_hint, 'Include the rail in frame')
  const escalation = spec.dashboard.panels.find((panel) => panel.type === 'escalation_card')
  assert.equal(escalation.reason, 'Blurry photos go to Leon first.')
  ok('applyProposal: wave string slots reword (capture_hint, escalation reason)')
}
{
  // Unknown or over-limit strings are dropped, never crash.
  const { spec, applied } = applyProposal(baseline, {
    strings: {
      'intake.components.photo_slot.nonexistent': 'nope',
      'intake.components.photo_slot.label': 'x'.repeat(400),
    },
    componentOps: [],
    thresholdTweaks: [],
    summary: '',
  })
  assert.equal(spec.intake.components.find((component) => component.id === 'photo_slot').label.length, 'Photos of the item'.length)
  assert.equal(applied.filter((entry) => entry.startsWith('changed')).length, 0)
  ok('applyProposal: unknown paths and over-limit values are dropped silently')
}
{
  // Threshold clamps: beyond ±0.1 steps to the bound; review stays below auto.
  const decision = baseline.judges.find((judge) => judge.id === 'decision_judge')
  const { spec } = applyProposal(baseline, {
    strings: {},
    componentOps: [],
    thresholdTweaks: [{ judgeId: 'decision_judge', auto: 0.5, review: 0.99 }],
    summary: '',
  })
  const tweaked = spec.judges.find((judge) => judge.id === 'decision_judge')
  assert.equal(tweaked.thresholds.auto, decision.thresholds.auto - 0.1, 'auto steps at most 0.1 down')
  assert.equal(tweaked.thresholds.review, decision.thresholds.review + 0.1, 'review steps at most 0.1 up')
  assert.ok(tweaked.thresholds.review < tweaked.thresholds.auto, 'review stays strictly below auto')
  ok('applyProposal: threshold tweaks clamp to the bounded band')
}
{
  // decision_log / usage_counter are always-on; the last intake component stays.
  const { spec } = applyProposal(baseline, {
    strings: {},
    componentOps: [
      { op: 'remove', component: 'decision_log' },
      { op: 'remove', component: 'usage_counter' },
    ],
    thresholdTweaks: [],
    summary: '',
  })
  assert.ok(spec.dashboard.panels.some((panel) => panel.type === 'decision_log'), 'decision_log is protected')
  assert.ok(spec.dashboard.panels.some((panel) => panel.type === 'usage_counter'), 'usage_counter is protected')

  const chatOnly = compileSpec('generic', applyFacts([]))
  const stripped = applyProposal(chatOnly, {
    strings: {},
    componentOps: [{ op: 'remove', component: 'chat' }],
    thresholdTweaks: [],
    summary: '',
  })
  assert.ok(stripped.spec.intake.components.length >= 1, 'an intake surface always remains')
  ok('applyProposal: always-on panels and the last intake component are protected')
}
{
  // Judge-bound panels cannot dangle: a confidence_meter add binds an existing
  // judge (after a full removal — the baseline carries one meter per judge).
  const stripped = applyProposal(baseline, {
    strings: {},
    componentOps: [{ op: 'remove', component: 'confidence_meter' }],
    thresholdTweaks: [],
    summary: '',
  })
  assert.ok(!stripped.spec.dashboard.panels.some((panel) => panel.type === 'confidence_meter'), 'meters removed')
  const { spec } = applyProposal(stripped.spec, {
    strings: {},
    componentOps: [{ op: 'add', component: 'confidence_meter' }],
    thresholdTweaks: [],
    summary: '',
  })
  const meter = spec.dashboard.panels.find((panel) => panel.type === 'confidence_meter')
  assert.ok(meter !== undefined, 'a meter was added back')
  assert.ok(spec.judges.some((judge) => judge.id === meter.judge_id), 'the added meter binds an existing judge')
  ok('applyProposal: judge-bound panels bind real judges only')
}

console.log(`\nVERIFY-BUILDER-SPEC: PASS (${passed} assertions)`)
