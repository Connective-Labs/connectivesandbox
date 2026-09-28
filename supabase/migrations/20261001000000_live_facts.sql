-- Livebuild v2: the fact ledger. Transcript segments are classified into
-- KEYED FACTS (openjev two-stage: material screen, then structured fact
-- extraction) and the WorkflowSpec is a compiled projection of the replayed
-- ledger (src/engine/compilers.ts). Repetition in speech is idempotent by
-- key: restating the photo requirement three times appends three rows but
-- replays to ONE active `intake.photo` fact.
--
-- Access design (Phase 5 gateway pattern, unchanged): the browser never talks
-- to PostgREST. RLS is enabled with NO policies (default deny) — even a valid
-- client JWT sees zero rows. All reads/writes ride the `live-facts` Edge
-- Function, which verifies the session cookie and acts with service_role
-- inside the trust boundary. Isolation is asserted in
-- supabase/tests/isolation_test.sql; end-to-end in
-- supabase/tests/live-transcribe-e2e.sh.

create table if not exists public.transcript_facts (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients (id) on delete cascade,
  workflow_id    uuid references public.workflows (id) on delete set null,
  session_id     text not null, -- transcript-call identifier (browser-generated), NOT a sessions row
  -- Deterministic slug from the closed catalogue (src/engine/catalogue.ts):
  -- e.g. intake.photo, judge.decision, judge.decision.options.site_visit.
  key            text not null,
  -- add | update | confirm | remove — replayed in (created_at, id) order.
  op             text not null check (op in ('add', 'update', 'confirm', 'remove')),
  -- intake | judges | dashboard
  area           text not null check (area in ('intake', 'judges', 'dashboard')),
  -- { strings: {...}, meta: {...} } — cached human-language strings (GLM
  -- fills them once, when the element is created) plus closed-vocabulary meta.
  detail         jsonb not null default '{}',
  -- Provenance: `seed` for recipe baseline facts, else `seg:<index>`.
  transcript_ref text,
  created_at     timestamptz not null default now()
);

create index if not exists transcript_facts_session_idx
  on public.transcript_facts (client_id, session_id, created_at, id);
create index if not exists transcript_facts_key_idx
  on public.transcript_facts (client_id, session_id, key);

alter table public.transcript_facts enable row level security;

-- No policies: default deny for anon + authenticated alike. Writes happen
-- with service_role inside `live-facts`; clients only ever see a spec after
-- it is published onto public.workflows through the existing publish path.
