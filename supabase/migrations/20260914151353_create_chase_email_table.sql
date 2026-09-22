-- Migration: create chase_email table
-- specs/attendance-payment-chasing/tasks.md 1.7
-- Enables: DC-2, DC-3, DC-4, DC-6

create table public.chase_email (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.person(id),
  debt_cycle_started_at timestamptz not null,
  sequence_number int not null,                -- 1 = first in cycle, requires approval
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','sent','cancelled')),
  approved_by uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.chase_email is
  'One row per drafted/sent chase email in a person''s debt cycle. See specs/attendance-payment-chasing/design.md.';

-- FK columns are not auto-indexed by Postgres.
create index chase_email_person_id_idx on public.chase_email (person_id);
-- Task 7.1's approval inbox queries status = 'pending_approval'.
create index chase_email_status_idx on public.chase_email (status);

-- RLS: deny-all. No admin-auth model exists yet; all access is server-side
-- via SUPABASE_SECRET_KEY (service_role, bypasses RLS regardless of policies).
alter table public.chase_email enable row level security;
alter table public.chase_email force row level security;
