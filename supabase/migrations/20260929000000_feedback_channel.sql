-- Feedback channel: clients message their service team from the workspace;
-- every client message is classified (openjev, closed set) and, for
-- wording/structure, drives the parallel-AI edit pipeline (planner adapter →
-- versioned spec drafts, source='feedback'). The rep answers in-thread; the
-- AI never sends client-facing text and never publishes.
--
-- Access design (Phase 5 gateway pattern, unchanged from transcript_segments
-- / spec_drafts): the browser never talks to PostgREST. RLS is enabled with
-- NO policies (default deny), so even a valid client JWT sees zero rows
-- directly — a client "sees own threads" and the admin "sees all" ONLY
-- through the `feedback` Edge Function, which verifies the session cookie
-- and scopes every read/write server-side with service_role. Isolation is
-- asserted in supabase/tests/isolation_test.sql; end-to-end scoping in
-- supabase/tests/feedback-e2e.sh.

create table if not exists public.feedback_messages (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  workflow_id   uuid references public.workflows (id) on delete set null,
  direction     text not null check (direction in ('client', 'rep')),
  body          text not null,
  -- Artifact descriptors uploaded through the existing artifact-api flow
  -- ({client_id}/{session_id}/{artifact_id}-{filename}); never raw bytes.
  attachments   jsonb not null default '[]',
  -- Closed-set classification for direction='client' rows:
  -- wording | structure | accuracy | feature_request | bug | question
  classification text check (classification in
    ('wording', 'structure', 'accuracy', 'feature_request', 'bug', 'question')),
  confidence    numeric check (confidence >= 0 and confidence <= 1),
  -- For accuracy rows: the judge/decision the client refers to, when
  -- identifiable. Accuracy is evaluation data — never auto-fixable.
  referenced_judge text,
  -- True when classification failed and the row fell back to 'question'
  -- (the message is never lost).
  classification_fallback boolean not null default false,
  read_by_rep   boolean not null default false,
  read_by_client boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists feedback_messages_client_idx
  on public.feedback_messages (client_id, created_at);

-- Link planner drafts back to the feedback message that triggered them, so
-- the inbox can show the client's words next to the proposed diff.
alter table public.spec_drafts
  add column if not exists feedback_message_id uuid references public.feedback_messages (id) on delete set null;

create index if not exists spec_drafts_feedback_idx
  on public.spec_drafts (client_id, source, created_at desc)
  where source = 'feedback';

alter table public.feedback_messages enable row level security;

-- No policies: default deny for anon + authenticated alike (same posture as
-- transcript_segments / spec_drafts). All access rides the `feedback` Edge
-- Function with the service role inside the trust boundary.
