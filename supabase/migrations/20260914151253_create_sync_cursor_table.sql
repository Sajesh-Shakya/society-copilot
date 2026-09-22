-- Migration: create sync_cursor table
-- specs/attendance-payment-chasing/tasks.md 1.6
-- Enables: AC-6, AC-7

create table public.sync_cursor (
  source text primary key check (source in ('eactivities','pluto')),
  last_synced_at timestamptz not null,
  last_synced_id text                          -- for sources with an increasing unique id
);

comment on table public.sync_cursor is
  'One row per external sync source, tracking incremental sync progress. See specs/attendance-payment-chasing/design.md.';

-- RLS: deny-all. No admin-auth model exists yet; all access is server-side
-- via SUPABASE_SECRET_KEY (service_role, bypasses RLS regardless of policies).
alter table public.sync_cursor enable row level security;
alter table public.sync_cursor force row level security;
