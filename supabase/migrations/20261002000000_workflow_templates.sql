-- Reusable template library (Phase 2): whole-workflow templates with
-- versioned lineage and parameterisation slots, plus workflow provenance.
--
-- Access design (Phase 5 gateway pattern, unchanged): the browser never talks
-- to PostgREST. workflow_templates has RLS enabled with NO policies (default
-- deny) — reachable ONLY via service_role inside Edge Functions, exactly like
-- clients / agent_instructions / transcript_facts. Templates are admin-facing
-- assets; clients never see them (they see published workflows only).
--
-- Template spec = the curated WorkflowSpec (frozen src/engine/types.ts shape).
-- slots = the parameterisation list computed by src/engine/templating.ts.
-- Lineage: parent_template_id chains versions; created_from_workflow_id
-- records provenance. workflows gain source_template_id /
-- source_template_version so a workflow remembers the template it came from.

create table if not exists public.workflow_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  category      text not null default 'custom', -- recipe id or 'custom'
  spec          jsonb not null,
  version       integer not null default 1,
  parent_template_id uuid references public.workflow_templates (id),
  created_from_workflow_id uuid references public.workflows (id),
  slots         jsonb not null default '[]'::jsonb,
  is_curated    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists workflow_templates_category_idx on public.workflow_templates (category);
create index if not exists workflow_templates_curated_idx  on public.workflow_templates (is_curated);

alter table public.workflow_templates enable row level security;

-- No policies: default deny for anon + authenticated alike. All access rides
-- the admin-api gateway with service_role inside.

alter table public.workflows
  add column if not exists source_template_id uuid references public.workflow_templates (id),
  add column if not exists source_template_version integer;
