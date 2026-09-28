-- Connective Sandbox — Phase 4 cross-tenant isolation test (the gate).
--
-- Run against the linked project:
--   supabase db query --linked --file supabase/tests/isolation_test.sql
--
-- Proves, using `set local role authenticated` + `set local request.jwt.claims`
-- for two client identities (TEST_CLIENT_A / TEST_CLIENT_B):
--   1. a client JWT can read its OWN rows (positive controls — so a bug that
--      hides everything cannot pass silently),
--   2. it CANNOT read another client's rows in workflows, sessions, messages,
--      artifacts, decisions,
--   3. it CANNOT write into another client's tenant,
--   4. it CANNOT read anything from clients, agent_instructions,
--      auth_attempts (no client-facing policy exists),
--   5. storage.objects in the private `artifacts` bucket are scoped to the
--      first path segment ({client_id}/...).
--
-- Any leak raises an exception; supabase db query exits non-zero on SQL
-- errors. The whole script runs inside one transaction, so on any failure all
-- fixture rows roll back. Test rows use reserved UUIDs 11111111-... /
-- 22222222-... and are removed before commit.

begin;

-- ---------------------------------------------------------------------------
-- Fixture rows (run as postgres — the table owner bypasses RLS)
-- ---------------------------------------------------------------------------

-- Idempotent clean-up of any previous failed run (cascade order).
delete from public.decisions where session_id in (select id from public.sessions where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));
delete from public.artifacts where session_id in (select id from public.sessions where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));
delete from public.messages  where session_id in (select id from public.sessions where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));
delete from public.sessions  where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
delete from public.workflows where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
delete from public.clients   where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
delete from public.auth_attempts where code_hash = 'isolation-test-hash';
-- NOTE: storage.objects rows are NOT cleaned by DELETE (Supabase protects
-- direct deletion from storage tables). The metadata rows inserted below are
-- discarded with a savepoint rollback instead.

insert into public.clients (id, name, access_code, contact)
values
  ('11111111-1111-1111-1111-111111111111', '__isolation_test_a', 'test-code-a', 'test-a@example.invalid'),
  ('22222222-2222-2222-2222-222222222222', '__isolation_test_b', 'test-code-b', 'test-b@example.invalid');

insert into public.workflows (id, client_id, name, spec, status)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '__isolation_test_workflow_a',
    '{"name":"__isolation_test_workflow_a","description":"test fixture","intake":{"components":[]},"judges":[],"dashboard":{"panels":[]}}'::jsonb,
    'published'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', '__isolation_test_workflow_b',
    '{"name":"__isolation_test_workflow_b","description":"test fixture","intake":{"components":[]},"judges":[],"dashboard":{"panels":[]}}'::jsonb,
    'published');

insert into public.sessions (id, workflow_id, client_id)
values
  ('aaaaaaaa-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000b001', 'bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222');

insert into public.messages (id, session_id, role, content)
values
  ('aaaaaaaa-0000-0000-0000-00000000aa01', 'aaaaaaaa-0000-0000-0000-00000000a001', 'user', 'tenant A message'),
  ('bbbbbbbb-0000-0000-0000-00000000aa01', 'bbbbbbbb-0000-0000-0000-00000000b001', 'user', 'tenant B message');

insert into public.artifacts (id, session_id, storage_path, filename, mime_type, size)
values
  ('aaaaaaaa-0000-0000-0000-00000000ab01', 'aaaaaaaa-0000-0000-0000-00000000a001',
   '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-00000000a001/aaaaaaaa-0000-0000-0000-00000000ab01-report.pdf',
   'report.pdf', 'application/pdf', 1024),
  ('bbbbbbbb-0000-0000-0000-00000000ab01', 'bbbbbbbb-0000-0000-0000-00000000b001',
   '22222222-2222-2222-2222-222222222222/bbbbbbbb-0000-0000-0000-00000000b001/bbbbbbbb-0000-0000-0000-00000000ab01-report.pdf',
   'report.pdf', 'application/pdf', 1024);

insert into public.decisions (id, session_id, workflow_id, judge_id, question, answer, confidence, probabilities)
values
  ('aaaaaaaa-0000-0000-0000-00000000d001', 'aaaaaaaa-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'j1', 'fixture question A', 'yes', 0.9, '{"yes":0.9,"no":0.1}'),
  ('bbbbbbbb-0000-0000-0000-00000000d001', 'bbbbbbbb-0000-0000-0000-00000000b001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'j1', 'fixture question B', 'no', 0.8, '{"yes":0.2,"no":0.8}');

insert into public.auth_attempts (code_hash, ip, success)
values ('isolation-test-hash', '127.0.0.1', false);

-- Storage metadata rows mirroring the {client_id}/{session_id}/{artifact_id}-{filename}
-- path convention (no bytes uploaded; the RLS policies on storage.objects are
-- what we are testing). Everything after this savepoint that touches
-- storage.objects is discarded by `rollback to savepoint storage_rows` below,
-- because direct DELETE from storage.tables is blocked by Supabase.
savepoint storage_rows;

insert into storage.objects (bucket_id, name, owner_id, metadata)
values
  ('artifacts',
   '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-00000000a001/aaaaaaaa-0000-0000-0000-00000000ab01-report.pdf',
   null, '{}'::jsonb),
  ('artifacts',
   '22222222-2222-2222-2222-222222222222/bbbbbbbb-0000-0000-0000-00000000b001/bbbbbbbb-0000-0000-0000-00000000ab01-report.pdf',
   null, '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- Identity A: positive controls + cross-tenant leak checks
-- ---------------------------------------------------------------------------

savepoint identity_a;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","client_id":"11111111-1111-1111-1111-111111111111"}';

do $$
declare
  n integer;
begin
  -- 1. Positive controls: identity A CAN read its own rows.
  select count(*) into n from public.workflows
    where client_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'FAIL: identity A cannot read its own workflows (got %, want 1)', n; end if;

  select count(*) into n from public.sessions
    where client_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'FAIL: identity A cannot read its own sessions (got %, want 1)', n; end if;

  select count(*) into n from public.messages m
    join public.sessions s on s.id = m.session_id
    where s.client_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'FAIL: identity A cannot read its own messages (got %, want 1)', n; end if;

  select count(*) into n from public.artifacts a
    join public.sessions s on s.id = a.session_id
    where s.client_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'FAIL: identity A cannot read its own artifacts (got %, want 1)', n; end if;

  select count(*) into n from public.decisions d
    join public.sessions s on s.id = d.session_id
    where s.client_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'FAIL: identity A cannot read its own decisions (got %, want 1)', n; end if;

  -- 2. Cross-tenant reads must return ZERO rows.
  select count(*) into n from public.workflows
    where client_id = '22222222-2222-2222-2222-222222222222';
  if n <> 0 then raise exception 'LEAK: A read B workflows by client_id (% rows)', n; end if;

  select count(*) into n from public.workflows
    where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'LEAK: A read B workflow by id'; end if;

  select count(*) into n from public.sessions
    where client_id = '22222222-2222-2222-2222-222222222222'
       or id = 'bbbbbbbb-0000-0000-0000-00000000b001';
  if n <> 0 then raise exception 'LEAK: A read B sessions'; end if;

  select count(*) into n from public.messages
    where session_id = 'bbbbbbbb-0000-0000-0000-00000000b001';
  if n <> 0 then raise exception 'LEAK: A read B messages'; end if;

  select count(*) into n from public.artifacts
    where session_id = 'bbbbbbbb-0000-0000-0000-00000000b001'
       or storage_path like '22222222-%';
  if n <> 0 then raise exception 'LEAK: A read B artifacts'; end if;

  select count(*) into n from public.decisions
    where session_id = 'bbbbbbbb-0000-0000-0000-00000000b001';
  if n <> 0 then raise exception 'LEAK: A read B decisions'; end if;

  -- 3. No client-facing policy tables: nothing is visible, not even A's own row.
  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'LEAK: A read clients (% rows)', n; end if;

  select count(*) into n from public.agent_instructions;
  if n <> 0 then raise exception 'LEAK: A read agent_instructions (% rows)', n; end if;

  select count(*) into n from public.auth_attempts;
  if n <> 0 then raise exception 'LEAK: A read auth_attempts (% rows)', n; end if;

  -- Live transcribe tables (gateway pattern): NO client-facing policies at
  -- all, so even the OWNING client sees zero rows — service_role inside
  -- `live-draft` is the only access path.
  select count(*) into n from public.transcript_segments;
  if n <> 0 then raise exception 'LEAK: A read transcript_segments (% rows)', n; end if;

  select count(*) into n from public.spec_drafts;
  if n <> 0 then raise exception 'LEAK: A read spec_drafts (% rows)', n; end if;

  begin
    insert into public.transcript_segments (client_id, session_id, segment_index, text)
    values ('11111111-1111-1111-1111-111111111111', 'isolation-test-call', 0, 'intrusion');
    raise exception 'LEAK: A inserted a transcript_segment';
  exception
    when insufficient_privilege then null; -- correctly rejected by RLS
  end;

  begin
    insert into public.spec_drafts (client_id, version, spec, delta_summary)
    values ('11111111-1111-1111-1111-111111111111', 1, '{}'::jsonb, 'intrusion');
    raise exception 'LEAK: A inserted a spec_draft';
  exception
    when insufficient_privilege then null; -- correctly rejected by RLS
  end;

  -- 4. Cross-tenant WRITE attempt must be rejected by WITH CHECK.
  begin
    insert into public.messages (session_id, role, content)
    values ('bbbbbbbb-0000-0000-0000-00000000b001', 'user', 'cross-tenant intrusion');
    raise exception 'LEAK: A inserted a message into B session';
  exception
    when insufficient_privilege then null; -- correctly rejected by RLS
  end;

  select count(*) into n from public.messages
    where session_id = 'bbbbbbbb-0000-0000-0000-00000000b001';
  if n <> 0 then raise exception 'LEAK: A wrote into B session'; end if;

  -- 5. Storage: A sees only its own {client_id}/... prefix in the artifacts bucket.
  select count(*) into n from storage.objects
    where bucket_id = 'artifacts'
      and name like '11111111-%';
  if n <> 1 then raise exception 'FAIL: A cannot see its own artifact object (got %, want 1)', n; end if;

  select count(*) into n from storage.objects
    where bucket_id = 'artifacts'
      and name like '22222222-%';
  if n <> 0 then raise exception 'LEAK: A read B artifact object'; end if;

  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('artifacts', '22222222-2222-2222-2222-222222222222/intrusion.txt', '{}'::jsonb);
    raise exception 'LEAK: A inserted an object under B prefix';
  exception
    when insufficient_privilege then null; -- correctly rejected by RLS
  end;
end $$;

rollback to savepoint identity_a; -- discards the local role + claims
rollback to savepoint storage_rows; -- discards the storage.objects test rows

-- ---------------------------------------------------------------------------
-- Identity B: same guarantees in the other direction
-- ---------------------------------------------------------------------------

savepoint identity_b;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","client_id":"22222222-2222-2222-2222-222222222222"}';

do $$
declare
  n integer;
begin
  select count(*) into n from public.workflows
    where client_id = '22222222-2222-2222-2222-222222222222';
  if n <> 1 then raise exception 'FAIL: identity B cannot read its own workflows (got %, want 1)', n; end if;

  select count(*) into n from public.workflows
    where client_id = '11111111-1111-1111-1111-111111111111'
       or id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'LEAK: B read A workflows'; end if;

  select count(*) into n from public.sessions
    where client_id = '11111111-1111-1111-1111-111111111111'
       or id = 'aaaaaaaa-0000-0000-0000-00000000a001';
  if n <> 0 then raise exception 'LEAK: B read A sessions'; end if;

  select count(*) into n from public.messages
    where session_id = 'aaaaaaaa-0000-0000-0000-00000000a001';
  if n <> 0 then raise exception 'LEAK: B read A messages'; end if;

  select count(*) into n from public.artifacts
    where session_id = 'aaaaaaaa-0000-0000-0000-00000000a001'
       or storage_path like '11111111-%';
  if n <> 0 then raise exception 'LEAK: B read A artifacts'; end if;

  select count(*) into n from public.decisions
    where session_id = 'aaaaaaaa-0000-0000-0000-00000000a001';
  if n <> 0 then raise exception 'LEAK: B read A decisions'; end if;

  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'LEAK: B read clients (% rows)', n; end if;

  select count(*) into n from public.agent_instructions;
  if n <> 0 then raise exception 'LEAK: B read agent_instructions (% rows)', n; end if;

  select count(*) into n from public.auth_attempts;
  if n <> 0 then raise exception 'LEAK: B read auth_attempts (% rows)', n; end if;

  select count(*) into n from public.transcript_segments;
  if n <> 0 then raise exception 'LEAK: B read transcript_segments (% rows)', n; end if;

  select count(*) into n from public.spec_drafts;
  if n <> 0 then raise exception 'LEAK: B read spec_drafts (% rows)', n; end if;

  begin
    insert into public.spec_drafts (client_id, version, spec, delta_summary)
    values ('22222222-2222-2222-2222-222222222222', 1, '{}'::jsonb, 'intrusion');
    raise exception 'LEAK: B inserted a spec_draft';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.messages (session_id, role, content)
    values ('aaaaaaaa-0000-0000-0000-00000000a001', 'user', 'cross-tenant intrusion');
    raise exception 'LEAK: B inserted a message into A session';
  exception
    when insufficient_privilege then null;
  end;

  select count(*) into n from public.messages
    where session_id = 'aaaaaaaa-0000-0000-0000-00000000a001';
  if n <> 0 then raise exception 'LEAK: B wrote into A session'; end if;
end $$;

rollback to savepoint identity_b;

-- ---------------------------------------------------------------------------
-- No claims at all (spoofed/bare JWT): everything is invisible
-- ---------------------------------------------------------------------------

savepoint claimless;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';

do $$
declare
  n integer;
begin
  select count(*) into n from public.workflows;
  if n <> 0 then raise exception 'LEAK: claimless JWT read workflows (% rows)', n; end if;

  select count(*) into n from public.sessions;
  if n <> 0 then raise exception 'LEAK: claimless JWT read sessions (% rows)', n; end if;

  select count(*) into n from public.messages;
  if n <> 0 then raise exception 'LEAK: claimless JWT read messages (% rows)', n; end if;

  select count(*) into n from public.artifacts;
  if n <> 0 then raise exception 'LEAK: claimless JWT read artifacts (% rows)', n; end if;

  select count(*) into n from public.decisions;
  if n <> 0 then raise exception 'LEAK: claimless JWT read decisions (% rows)', n; end if;

  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'LEAK: claimless JWT read clients (% rows)', n; end if;

  select count(*) into n from public.agent_instructions;
  if n <> 0 then raise exception 'LEAK: claimless JWT read agent_instructions (% rows)', n; end if;

  select count(*) into n from public.auth_attempts;
  if n <> 0 then raise exception 'LEAK: claimless JWT read auth_attempts (% rows)', n; end if;

  select count(*) into n from public.transcript_segments;
  if n <> 0 then raise exception 'LEAK: claimless JWT read transcript_segments (% rows)', n; end if;

  select count(*) into n from public.spec_drafts;
  if n <> 0 then raise exception 'LEAK: claimless JWT read spec_drafts (% rows)', n; end if;
end $$;

rollback to savepoint claimless;

-- ---------------------------------------------------------------------------
-- Clean up fixture rows and verify
-- ---------------------------------------------------------------------------

delete from public.decisions where session_id in (select id from public.sessions where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));
delete from public.artifacts where session_id in (select id from public.sessions where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));
delete from public.messages  where session_id in (select id from public.sessions where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));
delete from public.sessions  where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
delete from public.workflows where client_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
delete from public.clients   where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
delete from public.auth_attempts where code_hash = 'isolation-test-hash';

do $$
declare
  n integer;
begin
  select count(*) into n from public.clients
    where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
  if n <> 0 then raise exception 'CLEANUP FAIL: isolation fixture clients still present'; end if;
end $$;

select 'ISOLATION TEST: PASS — no cross-tenant leaks across workflows, sessions, messages, artifacts, decisions, clients, agent_instructions, auth_attempts, transcript_segments, spec_drafts, storage' as result;

commit;
