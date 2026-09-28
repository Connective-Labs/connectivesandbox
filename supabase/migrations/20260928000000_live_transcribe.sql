-- Live transcription pipeline: durable storage for transcript segments and
-- spec drafts produced by the `live-draft` Edge Function.
--
-- Access design (Phase 5 gateway pattern, unchanged): the browser never talks
-- to PostgREST. Both tables are reachable ONLY through Edge Functions that
-- verify the session cookie and act with service_role internally — exactly
-- like clients / agent_instructions / auth_attempts, which deliberately have
-- no client-facing policy. RLS is enabled with NO policies (default deny), so
-- even a valid client JWT sees zero rows. Admin access rides `live-draft` /
-- `admin-api`; nothing is visible to a client unless the rep publishes the
-- draft onto workflows.spec through the existing publish path.

create table if not exists public.transcript_segments (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  workflow_id   uuid references public.workflows (id) on delete set null,
  session_id    text not null, -- a transcript-call identifier (browser-generated), NOT a sessions row
  segment_index integer not null,
  text          text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.spec_drafts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  workflow_id   uuid references public.workflows (id) on delete set null,
  version       integer not null, -- per-workflow draft numbering (v1, v2, ...)
  spec          jsonb not null,
  delta_summary text not null,
  source        text not null default 'transcript', -- 'transcript' | 'manual' | 'chat'
  published     boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists transcript_segments_session_idx on public.transcript_segments (client_id, session_id, segment_index);
create index if not exists spec_drafts_workflow_idx        on public.spec_drafts (workflow_id, version desc);

alter table public.transcript_segments enable row level security;
alter table public.spec_drafts         enable row level security;

-- No policies: default deny for anon + authenticated alike. Writes happen
-- with service_role inside `live-draft`; clients only ever see a spec after
-- it is published onto public.workflows (which has the tenant-select policy).
