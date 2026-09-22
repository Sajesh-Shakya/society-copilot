-- Migration: create attendance_record table
-- specs/attendance-payment-chasing/tasks.md 1.5
-- Enables: AC-2, MP-1, MP-3

create table public.attendance_record (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.person(id),
  session_id uuid not null references public.session(id),
  attended boolean not null default true,
  source text not null check (source in ('signup_sync','manual_tick','walk_in')),
  waived_by_purchase_id uuid,                -- FK added below, once `purchase` exists
  recorded_by uuid,                          -- admin who ticked it, if manual
  recorded_at timestamptz not null default now(),
  unique (person_id, session_id)              -- idempotency: one attendance row per person/session
);

comment on table public.attendance_record is
  'One row per person/session attendance outcome. See specs/attendance-payment-chasing/design.md.';

alter table public.attendance_record
  add constraint attendance_record_waived_by_purchase_id_fkey
  foreign key (waived_by_purchase_id) references public.purchase(id);

-- FK columns are not auto-indexed by Postgres. unique(person_id, session_id)
-- already indexes person_id as the leading column; session_id needs its own
-- index (AC-3 Realtime subscriptions scoped to session_id; attendance screen).
create index attendance_record_session_id_idx on public.attendance_record (session_id);
create index attendance_record_waived_by_purchase_id_idx on public.attendance_record (waived_by_purchase_id);

alter table public.attendance_record enable row level security;
alter table public.attendance_record force row level security;

-- Split RLS (user decision, see specs/attendance-payment-chasing/tasks.md
-- Phase 3 tracked-gap task): unlike person/purchase's deny-all, anon gets
-- read-only access here because Supabase Realtime's postgres_changes must
-- deliver events to a browser using the public anon key -- no auth system
-- exists yet. Only person_id (opaque uuid)/session_id/attended/source/
-- timestamps are exposed; person itself stays locked down, so an anon
-- client can't resolve person_id to a name or email.
create policy attendance_record_select_anon on public.attendance_record
  for select
  to anon
  using (true);
-- No insert/update/delete policy for anon -> denied. Writes go through a
-- server route using SUPABASE_SECRET_KEY (task 3.2), where the
-- UNIQUE(person_id, session_id) idempotency check and audit logging happen.

-- TRACKED GAP: replace attendance_record_select_anon above with an
-- authenticated-admin-role-only policy once a real auth system is built.
-- See specs/attendance-payment-chasing/tasks.md, Phase 3 (after 3.3).
