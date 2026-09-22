-- Migration: create purchase table
-- specs/attendance-payment-chasing/tasks.md 1.4
-- Enables: MP-4, MP-5, MP-6

create table public.purchase (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references public.person(id),       -- null until matched (unmatched external row)
  product_id uuid references public.product(id),
  source text not null check (source in ('pluto_api','xlsx_upload')),
  source_row_id text,                          -- Pluto's unique sale id, or a hash of an XLSX row for idempotency
  raw_member_type text,                        -- verbatim value from Pluto/XLSX, kept for audit
  purchased_at timestamptz not null,
  match_status text not null default 'unmatched'
    check (match_status in ('cid_matched','email_matched','manual_matched','unmatched')),
  matched_by uuid,                             -- admin who confirmed a manual match, if applicable
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, source_row_id)                -- idempotency: same sale never ingested twice
);

comment on table public.purchase is
  'One row per ingested Pluto/XLSX purchase or membership sale. See specs/attendance-payment-chasing/design.md.';

-- FK columns are not auto-indexed by Postgres.
create index purchase_person_id_idx on public.purchase (person_id);
create index purchase_product_id_idx on public.purchase (product_id);
-- Task 4.6's manual-review queue queries match_status = 'unmatched'.
create index purchase_match_status_idx on public.purchase (match_status);

-- RLS: deny-all. Holds no PII directly but joins to person; no admin-auth
-- model exists yet. All access is server-side via SUPABASE_SECRET_KEY
-- (service_role, bypasses RLS regardless of policies).
alter table public.purchase enable row level security;
alter table public.purchase force row level security;
