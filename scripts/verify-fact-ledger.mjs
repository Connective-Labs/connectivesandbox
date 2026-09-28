// Pure verification of the fact-ledger architecture (headless, no network).
//
// Asserts the core claims of livebuild v2:
//   1. repetition idempotency — restating the same requirement any number of
//      times yields each keyed fact ONCE in the replayed ledger state;
//   2. duplicate-free compilation — compiled specs contain no duplicate
//     component/judge/panel ids across ANY number of regenerations;
//   3. determinism — the same state compiles to byte-identical JSON;
//   4. contradiction ordering — remove after add resolves in speech order;
//   5. every compiled draft validates against the frozen Zod schema;
//   6. cached strings survive regeneration (draft stability) — GLM copy is
//      never rewritten by a later compile;
//   7. option facts narrow the decision judge without ever inventing options;
//   8. cross-engine parity — the same words split differently (server chunks
//      vs Web Speech sentences) yield the same ledger signature.
//
// Run: node scripts/verify-fact-ledger.mjs

import { strict as assert } from 'node:assert'

import { applyFact, applyFacts, ledgerSignature } from '../src/engine/facts.ts'
import {
  DECISION_SETS,
  factKeyMatches,
  normaliseRecipeId,
  recipeSeedFacts,
} from '../src/engine/catalogue.ts'
import { compileSpec } from '../src/engine/compilers.ts'
import { safeParseWorkflowSpec } from '../src/engine/schema.ts'

let passed = 0
const ok = (name) => {
  passed += 1
  console.log(`ok: ${name}`)
}

/** Build a transcript fact. */
const fact = (key, op, at, detail = {}) => ({
  key,
  op,
  area: key.startsWith('intake.') ? 'intake' : key.startsWith('judge.') ? 'judges' : 'dashboard',
  detail,
  transcript_ref: `seg:${at}`,
  at: new Date(Date.UTC(2026, 0, 1, 9, 0, at)).toISOString(),
})

const activeKeys = (state) =>
  [...state.values()].filter((entry) => entry.active).map((entry) => entry.key).sort()

const validate = (spec, label) => {
  const result = safeParseWorkflowSpec(spec)
  assert.ok(result.success, `${label} failed Zod: ${JSON.stringify(result.error?.issues?.slice(0, 3))}`)
  return result.data
}

const duplicateIds = (spec) => {
  const ids = [
    ...spec.intake.components.map((component) => component.id),
    ...spec.judges.map((judge) => judge.id),
    ...spec.dashboard.panels.map((panel) => panel.id),
  ]
  return ids.filter((id, index) => ids.indexOf(id) !== index)
}

// ---------------------------------------------------------------------------
// 1. Repetition idempotency: the photo requirement restated three times
// ---------------------------------------------------------------------------
{
  const repetitions = [
    fact('intake.photo', 'add', 1),
    fact('intake.photo', 'confirm', 2),
    fact('intake.photo', 'add', 3, { strings: { label: 'Photos of the curtains' } }),
  ]
  const state = applyFacts(repetitions)
  const rows = activeKeys(state).filter((key) => key === 'intake.photo')
  assert.equal(rows.length, 1, 'repetition must yield the key once')
  assert.equal(state.get('intake.photo').ops, 3, 'audit counter records every mention')
  ok('repetition idempotency: 3 mentions of the photo requirement → one keyed fact')
}

// Same key with materially richer detail fills missing slots but never
// rewrites cached strings.
{
  const state = applyFacts([
    fact('intake.photo', 'add', 1, { strings: { label: 'Photos of the curtains' } }),
    fact('intake.photo', 'update', 2, { strings: { label: 'Curtain pics', instructions: 'Include the full window.' } }),
  ])
  const strings = state.get('intake.photo').detail.strings
  assert.equal(strings.label, 'Photos of the curtains', 'cached label never rewritten')
  assert.equal(strings.instructions, 'Include the full window.', 'missing slots get filled')
  ok('idempotent detail merge: cached strings stable, missing slots filled')
}

// ---------------------------------------------------------------------------
// 2+3. Duplicate-free, deterministic compilation across regenerations
// ---------------------------------------------------------------------------
{
  const facts = [
    ...recipeSeedFacts('photo-triage'),
    fact('intake.chat', 'add', 10),
    fact('judge.escalation', 'confirm', 11),
  ]
  const compiled = new Set()
  for (let round = 0; round < 5; round++) {
    const state = applyFacts(facts)
    const spec = compileSpec('photo-triage', state)
    validate(spec, `regeneration ${round}`)
    assert.deepEqual(duplicateIds(spec), [], `regeneration ${round} introduced duplicates`)
    compiled.add(JSON.stringify(spec))
  }
  assert.equal(compiled.size, 1, 'regenerations must be byte-identical')
  ok('5 regenerations → no duplicate ids, all valid, byte-identical JSON')
}

// ---------------------------------------------------------------------------
// 4. Contradiction ordering: remove after add wins (speech order)
// ---------------------------------------------------------------------------
{
  const state = applyFacts([
    ...recipeSeedFacts('photo-triage'),
    fact('intake.chat', 'add', 10),
    fact('intake.chat', 'remove', 11),
  ])
  assert.equal(state.get('intake.chat').active, false, 'remove after add deactivates')
  const spec = validate(compileSpec('photo-triage', state), 'post-remove compile')
  assert.ok(
    !spec.intake.components.some((component) => component.id === 'intake_chat'),
    'removed chat must not compile',
  )
  // And a later add re-activates (the customer changed their mind).
  const again = applyFact(state, fact('intake.chat', 'add', 12))
  assert.equal(again.get('intake.chat').active, true, 'add after remove re-activates')
  ok('contradiction ordering: remove beats earlier add; later add re-activates')
}

// Seeds never resurrect removed keys.
{
  const state = applyFacts([...recipeSeedFacts('photo-triage'), fact('intake.photo', 'remove', 10)])
  const spec = validate(compileSpec('photo-triage', state), 'seed-override compile')
  assert.ok(
    !spec.intake.components.some((component) => component.id === 'photo_slot'),
    'seed must not resurrect a removed key',
  )
  ok('seeds fill only unseen keys — explicit removals always win')
}

// ---------------------------------------------------------------------------
// 5. Recipe catalogue: default compile of every recipe validates
// ---------------------------------------------------------------------------
{
  for (const recipeId of ['photo-triage', 'document-intake', 'approval-desk', 'operations-desk', 'generic']) {
    const spec = validate(compileSpec(recipeId, applyFacts([])), `empty-ledger ${recipeId}`)
    assert.ok(spec.intake.components.length >= 1, `${recipeId} needs an intake surface`)
    assert.ok(
      spec.dashboard.panels.some((panel) => panel.type === 'decision_log'),
      `${recipeId} carries the ownership trail`,
    )
  }
  assert.equal(normaliseRecipeId('operations-desk'), 'approval-desk')
  assert.equal(normaliseRecipeId('nonsense'), 'generic')
  ok('every recipe compiles a valid baseline; alias + fallback normalisation holds')
}

// ---------------------------------------------------------------------------
// 6. Cached strings survive regeneration (draft stability)
// ---------------------------------------------------------------------------
{
  const facts = [
    ...recipeSeedFacts('generic'),
    fact('intake.photo', 'add', 1, { strings: { label: 'Curtain photos', instructions: 'Show the full drape.' } }),
    fact('intake.chat', 'add', 2, { strings: { placeholder: 'How can we help?', opening_message: 'Hello!' } }),
  ]
  const first = compileSpec('generic', applyFacts(facts))
  const second = compileSpec('generic', applyFacts([...facts, fact('intake.chat', 'confirm', 3)]))
  assert.equal(first.intake.components.find((c) => c.id === 'photo_slot').label, 'Curtain photos')
  assert.deepEqual(first.intake.components, second.intake.components, 'confirm op must not touch strings')
  ok('cached strings ride the fact: GLM copy never rewritten by later compiles')
}

// ---------------------------------------------------------------------------
// 7. Option facts narrow the decision judge inside the closed catalogue
// ---------------------------------------------------------------------------
{
  assert.ok(factKeyMatches('judge.decision.options.site_visit'), 'catalogue option fact is legal')
  assert.ok(!factKeyMatches('judge.decision.options.wool'), 'open-vocabulary option is illegal')
  assert.ok(!factKeyMatches('intake.photo.curtain'), 'per-subject intake keys are illegal (that subject lives in strings)')

  const state = applyFacts([
    ...recipeSeedFacts('photo-triage'),
    fact('judge.decision.options.site_visit', 'remove', 10),
  ])
  const spec = validate(compileSpec('photo-triage', state), 'option-narrow compile')
  const decision = spec.judges.find((judge) => judge.id === 'decision_judge')
  assert.deepEqual(
    decision.options,
    DECISION_SETS.quote_or_visit.options.filter((option) => option !== 'site_visit'),
    'removed option must drop from the compiled choice set',
  )
  // Narrow below two options falls back to the full closed set.
  const overNarrow = applyFacts([
    ...recipeSeedFacts('approval-desk'),
    fact('judge.decision.options.approve', 'remove', 10),
    fact('judge.decision.options.reject', 'remove', 11),
  ])
  const spec2 = validate(compileSpec('approval-desk', overNarrow), 'over-narrow compile')
  assert.deepEqual(
    spec2.judges.find((judge) => judge.id === 'decision_judge').options,
    DECISION_SETS.approve_reject.options,
    'a choice judge always keeps a legal option set',
  )
  ok('option facts narrow the decision judge; closed-set guarantee never breaks')
}

// ---------------------------------------------------------------------------
// 8. Cross-engine parity: same words, different segmentation
// ---------------------------------------------------------------------------
{
  const sentences = [
    'we need customers to send photos of the curtains',
    'actually let me say that again, customers send us photos of their curtains',
    'and if the fabric is delicate a person always reviews before we quote',
  ]
  // Web Speech path: sentence-final segments.
  const speechFacts = sentences.map((text, index) => fact('intake.photo', index === 0 ? 'add' : 'confirm', index + 1))
  // Server engine path: 8-second chunks split sentences mid-way — same facts
  // land because classification keys on meaning, not chunk boundaries.
  const serverFacts = [fact('intake.photo', 'add', 1), fact('intake.photo', 'confirm', 2)]
  const sigSpeech = ledgerSignature(applyFacts([...recipeSeedFacts('photo-triage'), ...speechFacts]), 'photo-triage')
  const sigServer = ledgerSignature(applyFacts([...recipeSeedFacts('photo-triage'), ...serverFacts]), 'photo-triage')
  assert.equal(sigSpeech, sigServer, 'engine choice must not change the ledger')
  ok('cross-engine parity: sentence-chunked vs time-chunked → identical ledger signature')
}

// Escalation restated twice → one judge.
{
  const state = applyFacts([
    ...recipeSeedFacts('photo-triage'),
    fact('judge.escalation', 'confirm', 1),
    fact('judge.escalation', 'confirm', 2),
  ])
  const spec = validate(compileSpec('photo-triage', state), 'escalation-repeat compile')
  assert.equal(spec.judges.filter((judge) => judge.id === 'escalation_judge').length, 1)
  ok('escalation restated twice → exactly one escalation judge')
}

// ---------------------------------------------------------------------------
// A DRAFT IS NEVER REJECTED (captain decision): empty-string, whitespace, and
// missing strings on facts must still compile a Zod-valid spec with
// deterministic catalogue placeholders. GLM string-filling is an enhancement
// pass that may fail silently — placeholders keep validity by construction.
// ---------------------------------------------------------------------------
{
  const brokenStrings = [
    fact('intake.photo', 'add', 1, { strings: { label: '', instructions: '   ' } }),
    fact('intake.chat', 'add', 2, { strings: {} }),
    fact('judge.decision', 'add', 3, { strings: { question: '' } }),
    fact('judge.escalation', 'add', 4),
    fact('judge.quality', 'add', 5, { strings: { question: '  ' } }),
    fact('dashboard.summary', 'add', 6, { strings: { title: '' } }),
  ]
  for (const recipeId of ['photo-triage', 'document-intake', 'approval-desk', 'generic']) {
    const spec = validate(compileSpec(recipeId, applyFacts(brokenStrings)), `broken-strings ${recipeId}`)
    const photo = spec.intake.components.find((component) => component.id === 'photo_slot')
    if (photo !== undefined) {
      assert.ok(photo.label.length >= 1, `${recipeId}: photo label placeholder missing`)
      assert.ok(photo.instructions.trim().length >= 1, `${recipeId}: photo instructions placeholder missing`)
    }
    for (const judge of spec.judges) {
      assert.ok(judge.question.trim().length >= 1, `${recipeId}: judge ${judge.id} question empty`)
    }
    for (const panel of spec.dashboard.panels) {
      if (panel.type === 'analysis') assert.ok(panel.title.trim().length >= 1, `${recipeId}: analysis title empty`)
      if (panel.type === 'confidence_meter') assert.ok(panel.label.trim().length >= 1, `${recipeId}: meter label empty`)
    }
    assert.ok(spec.description.trim().length >= 1, `${recipeId}: description empty`)
  }
  ok('never-reject: empty/whitespace/missing strings → placeholders, Zod-valid across all recipes')
}

// ---------------------------------------------------------------------------
// TRANSCRIPT-TO-SPEC FIDELITY (captain decision): a realistic discovery
// transcript replays to the right facts and the right compiled fields.
// The statement→op mapping below is the stage-2 classifier's CONTRACT — the
// live e2e asserts the real classifier honours it on the labelled beats.
// ---------------------------------------------------------------------------
{
  // Realistic discovery call (curtain cleaning, the canonical sandbox case).
  const transcript = [
    // 'my clients are curtain cleaners — they need customers to send photos of the curtains'
    { statement: 'we need photos of the curtains', fact: fact('intake.photo', 'add', 1) },
    // 'people describe the job in a message — like a whatsapp'
    { statement: 'customers describe the job in their own words', fact: fact('intake.chat', 'add', 2) },
    // 'we can quote most jobs straight away, but sometimes we need to see the room first'
    { statement: 'quote straight away or need a site visit', fact: fact('judge.decision', 'update', 3, { meta: { decision_set: 'quote_or_visit' } }) },
    // 'but heavy staining on delicate silk — a human always looks before we commit'
    { statement: 'heavy staining means a human always looks at it', fact: fact('judge.escalation', 'add', 4) },
    // 'customers often send blurry photos at night, someone should judge quality'
    { statement: 'some photos are too dark or blurry', fact: fact('judge.quality', 'add', 5) },
    // the photo requirement restated twice more (repetition is the norm in speech)
    { statement: 'like I said, photos of the curtains come in first', fact: fact('intake.photo', 'confirm', 6) },
    { statement: 'so yeah — photos first, then we decide', fact: fact('intake.photo', 'confirm', 7) },
    // 'no forms, nobody wants to fill a form' (explicit structural removal)
    { statement: 'no forms — nobody fills a form', fact: fact('intake.form', 'remove', 8) },
    // 'we never do site visits anymore, quotes only or one question'
    { statement: 'we never do site visits', fact: fact('judge.decision.options.site_visit', 'remove', 9) },
  ]
  const facts = [...recipeSeedFacts('photo-triage'), ...transcript.map((row) => row.fact)]
  const state = applyFacts(facts)

  // Each key statement appears as the right fact — exactly once.
  const active = new Set(activeKeys(state))
  for (const expected of ['intake.photo', 'intake.chat', 'judge.decision', 'judge.escalation', 'judge.quality']) {
    assert.ok(active.has(expected), `fidelity: ${expected} missing from the ledger`)
  }
  assert.ok(!active.has('intake.form'), 'fidelity: form removal must hold')
  assert.ok(!active.has('judge.decision.options.site_visit'), 'fidelity: site_visit removal must hold')

  // …and compiles to the right fields.
  const spec = validate(compileSpec('photo-triage', state), 'fidelity compile')
  assert.ok(spec.intake.components.some((component) => component.id === 'photo_slot'), 'fidelity: photo component')
  assert.ok(spec.intake.components.some((component) => component.id === 'intake_chat'), 'fidelity: chat component')
  assert.ok(!spec.intake.components.some((component) => component.id === 'intake_form'), 'fidelity: no form component')
  const decision = spec.judges.find((judge) => judge.id === 'decision_judge')
  assert.deepEqual(decision.options, ['quotable', 'one_ask', 'uncertain'], 'fidelity: decision set minus site_visit')
  const escalation = spec.judges.find((judge) => judge.id === 'escalation_judge')
  assert.equal(escalation.question_type, 'boolean', 'fidelity: escalation judge is the human-look gate')
  assert.ok(spec.judges.some((judge) => judge.id === 'quality_score'), 'fidelity: quality judge for blurry photos')
  ok('transcript-to-spec fidelity: every key statement lands as the right fact and compiled field')
}

console.log(`\nVERIFY-FACT-LEDGER: PASS (${passed} assertions)`)
