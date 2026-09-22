-- Migration: create product table
-- specs/attendance-payment-chasing/tasks.md 1.3
-- Enables: MP-1, MP-2, MP-3

create table public.product (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('session_pass','term_pass','annual_pass','other')),
  covers_sessions int,
  created_at timestamptz not null default now()
);

comment on table public.product is
  'Purchasable pass/membership types. See specs/attendance-payment-chasing/design.md.';

-- RLS: deny-all. No admin-auth model exists yet; all access is server-side
-- via SUPABASE_SECRET_KEY (service_role, bypasses RLS regardless of policies).
alter table public.product enable row level security;
alter table public.product force row level security;
