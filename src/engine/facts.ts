// The fact ledger — the source of truth for live-built workflows (livebuild
// v2). A discovery call no longer regenerates the spec from rolling prose;
// instead the transcript is classified into KEYED FACTS and the spec is a
// compiled projection of the replayed ledger (src/engine/compilers.ts).
//
// Why keyed facts: repetition in speech (the same requirement restated three
// times) used to produce duplicated modules, because the draft brain saw only
// prose. Here every fact carries a deterministic key; replaying the ledger is
// idempotent by key — `add intake.photo` three times yields ONE photo slot.
// The ledger replays deterministically in append order, so contradictions
// (remove after add) resolve in speech order.
//
// Pure module: no imports from src/data/, Supabase, or any network library.

/** Ledger operations, in replay order. */
export type FactOp = 'add' | 'update' | 'confirm' | 'remove'

/** Coarse area a fact contributes to. */
export type FactArea = 'intake' | 'judges' | 'dashboard'

/**
 * Human-language strings cached on a fact (GLM fills these for NEWLY created
 * elements only; existing elements are never re-written — draft stability).
 * Slot names are element-scoped: `label`, `instructions`, `placeholder`,
 * `opening_message`, `question`, `title`.
 */
export type FactStrings = Partial<
  Record<'label' | 'instructions' | 'placeholder' | 'opening_message' | 'question' | 'title', string>
>

/** Closed-vocabulary extras carried on a fact (never free-form structure). */
export interface FactMeta {
  /** For judge.decision: which catalogue decision set is in force. */
  decision_set?: string
  /** For judge.decision.options.<opt>: whether the option is in force. */
  active?: boolean
  /** Provenance: 'recipe' for seed facts, 'transcript' for classified ones. */
  source?: 'recipe' | 'transcript'
}

export interface FactDetail {
  strings?: FactStrings
  meta?: FactMeta
}

/** One appended fact (a row in transcript_facts, or a seed). */
export interface LedgerFact {
  key: string
  op: FactOp
  area: FactArea
  detail: FactDetail
  /** e.g. `seg:12` — the transcript segment that produced the fact. */
  transcript_ref?: string | null
  /** Wall-clock ISO timestamp; replay orders by this. */
  at: string
}

/** The current state of one key after replaying the ledger. */
export interface FactStateEntry {
  key: string
  area: FactArea
  /** false once a `remove` op has been replayed for the key. */
  active: boolean
  detail: FactDetail
  /** How many facts touched this key (audit view). */
  ops: number
  lastOp: FactOp
  lastAt: string
}

export type FactLedgerState = Map<string, FactStateEntry>

function emptyDetail(): FactDetail {
  return {}
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Merge `incoming` into `base`: non-empty strings/meta keys win when the
 *  base lacks them. Existing strings are never overwritten by empties, so
 *  cached copy is stable and regeneration is idempotent. */
function mergeDetail(base: FactDetail, incoming: FactDetail): FactDetail {
  const strings: FactStrings = { ...base.strings }
  for (const [slot, value] of Object.entries(incoming.strings ?? {})) {
    if (isNonEmpty(value) && !isNonEmpty(strings[slot as keyof FactStrings])) {
      strings[slot as keyof FactStrings] = value
    }
  }
  const meta: FactMeta = { ...base.meta }
  for (const [slot, value] of Object.entries(incoming.meta ?? {})) {
    if (value !== undefined && meta[slot as keyof FactMeta] === undefined) {
      meta[slot as keyof FactMeta] = value as never
    }
  }
  const detail: FactDetail = {}
  if (Object.keys(strings).length > 0) detail.strings = strings
  if (Object.keys(meta).length > 0) detail.meta = meta
  return detail
}

function cloneEntry(entry: FactStateEntry): FactStateEntry {
  return { ...entry, detail: mergeDetail(entry.detail, {}) }
}

/**
 * Apply ONE fact to the ledger state and return the next state. Pure: the
 * input map is never mutated. Idempotency by key:
 *  - `add` on an active key is a no-op unless the incoming detail is
 *    materially richer (fills string/meta slots the entry lacks);
 *  - `confirm` never changes structure (audit counters only);
 *  - `update` merges detail into the active entry;
 *  - `remove` deactivates the key; a later `add` re-activates it.
 */
export function applyFact(state: FactLedgerState, fact: LedgerFact): FactLedgerState {
  const next = new Map(state)
  const existing = next.get(fact.key)
  const at = fact.at

  if (existing === undefined) {
    // A `remove` on a never-added key still records: option facts
    // (judge.decision.options.<opt>) are implicitly active without a fact,
    // so their removal must land as an inactive entry. Structure keys get a
    // harmless tombstone (inactive entries never compile or sign).
    next.set(fact.key, {
      key: fact.key,
      area: fact.area,
      active: fact.op !== 'remove',
      detail: mergeDetail(emptyDetail(), fact.detail),
      ops: 1,
      lastOp: fact.op,
      lastAt: at,
    })
    return next
  }

  const entry = cloneEntry(existing)
  entry.ops += 1
  entry.lastOp = fact.op
  entry.lastAt = at

  switch (fact.op) {
    case 'add':
      // Idempotent by key: an add on an active entry only fills slots the
      // entry is missing (materially richer), never rewrites or duplicates.
      entry.active = true
      entry.detail = mergeDetail(entry.detail, fact.detail)
      break
    case 'confirm':
      entry.active = true
      entry.detail = mergeDetail(entry.detail, fact.detail)
      break
    case 'update':
      entry.active = true
      entry.detail = mergeDetail(entry.detail, fact.detail)
      break
    case 'remove':
      entry.active = false
      break
  }
  next.set(fact.key, entry)
  return next
}

/** Replay facts (in append order) into a ledger state. */
export function applyFacts(facts: readonly LedgerFact[]): FactLedgerState {
  let state: FactLedgerState = new Map()
  for (const fact of facts) state = applyFact(state, fact)
  return state
}

/** Active entries, deterministic order (by key). */
export function activeEntries(state: FactLedgerState): FactStateEntry[] {
  return [...state.values()].filter((entry) => entry.active).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * Deterministic signature of the ledger state. With strings included (the
 * default) it captures everything the compilers consume — used to skip
 * drafts when appended facts changed nothing material. With strings excluded
 * it is the STRUCTURAL signature: the same facts always yield the same
 * structural signature regardless of which GLM copy got cached — that is the
 * cross-engine parity guarantee (engine choice must not change the ledger).
 */
export function ledgerSignature(
  state: FactLedgerState,
  recipeId: string,
  options: { strings?: boolean } = {},
): string {
  const includeStrings = options.strings !== false
  const parts = [`recipe:${recipeId}`]
  for (const entry of activeEntries(state)) {
    const detail = includeStrings
      ? entry.detail
      : { meta: entry.detail.meta }
    parts.push(`${entry.key}|${stableStringify(detail)}`)
  }
  return parts.join('\n')
}

/** Stable JSON stringify (sorted object keys) for signatures. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** Parse a fact key into its area-local shape, e.g. judge.decision.options.site_visit. */
export function splitFactKey(key: string): string[] {
  return key.split('.').filter((part) => part.length > 0)
}
