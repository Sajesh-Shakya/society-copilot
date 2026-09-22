-- Migration: create person table
-- specs/attendance-payment-chasing/tasks.md 1.1
-- Enables: AC-4, AC-5, MP-5, DC-5

create extension if not exists pgcrypto;

create table public.person (
  id uuid primary key default gen_random_uuid(),
  cid text,                                   -- Imperial CID; null until known
  shortcode text,                             -- e.g. 'ss5123' — optional, candidate CID key
  email text not null,                        -- always required for external walk-ins
  full_name text not null,
  is_student boolean,                         -- derived from Member Type at last known purchase/signup
  identity_confidence text not null default 'confirmed'
    check (identity_confidence in ('provisional','confirmed')),
  consent_to_reinvite text not null default 'not_asked'
    check (consent_to_reinvite in ('not_asked','opted_in','opted_out')),
  is_exempt boolean not null default false,
  exempt_set_by uuid references public.person(id),
  exempt_set_at timestamptz,
  archived_at timestamptz,                    -- year-end reset, zero-debt only
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.person is
  'One row per known individual (member or external attendee). See specs/attendance-payment-chasing/design.md.';

-- Case-insensitive uniqueness (see judgment call 1 in the task-1.1 plan). cid
-- kept case-sensitive: Imperial CIDs are numeric strings, no case-folding concern.
create unique index person_cid_unique_idx on public.person (cid) where cid is not null;
create unique index person_email_unique_idx on public.person (lower(email));

-- Postgres does not auto-index FK columns.
create index person_exempt_set_by_idx on public.person (exempt_set_by);

-- Keep `updated_at` current on every row update. Reusable by future tables.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger person_set_updated_at
  before update on public.person
  for each row
  execute function public.set_updated_at();

-- RLS -----------------------------------------------------------------------
-- No admin-auth model exists yet (AGENTS.md: "no production auth unless
-- explicitly requested"). All reads/writes to `person` happen server-side
-- via Next.js route handlers using SUPABASE_SECRET_KEY (maps to Postgres
-- role `service_role`, which has BYPASSRLS and ignores every policy below
-- regardless). This policy is an explicit default-deny for anon/authenticated
-- so the publishable key used by lib/supabase/client.ts and the cookie-based
-- lib/supabase/server.ts client can never read or write person data, even by
-- accident, before any admin-auth model exists.
alter table public.person enable row level security;
alter table public.person force row level security;

create policy person_deny_anon_authenticated on public.person
  for all
  to anon, authenticated
  using (false)
  with check (false);
