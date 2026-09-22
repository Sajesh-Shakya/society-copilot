-- Migration: create session table
-- specs/attendance-payment-chasing/tasks.md 1.2
-- Enables: AC-1, AC-6, AC-7

create table public.session (
  id uuid primary key default gen_random_uuid(),
  eactivities_event_id text unique,
  title text not null,
  starts_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.session is
  'One row per scheduled session/event. See specs/attendance-payment-chasing/design.md.';

-- AC-7: scheduled job queries "sessions starting in ~1 hour" -> range scan on starts_at.
create index session_starts_at_idx on public.session (starts_at);

-- RLS: deny-all. No admin-auth model exists yet; all access is server-side
-- via SUPABASE_SECRET_KEY (service_role, bypasses RLS regardless of policies).
alter table public.session enable row level security;
alter table public.session force row level security;
