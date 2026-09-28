-- Fix-up: the spec_drafts rate guard (draft cooldown per transcript call)
-- keys on (client_id, session_id); the column was missing from the initial
-- live_transcribe migration.

alter table public.spec_drafts add column if not exists session_id text;

create index if not exists spec_drafts_session_idx on public.spec_drafts (client_id, session_id, created_at desc);
