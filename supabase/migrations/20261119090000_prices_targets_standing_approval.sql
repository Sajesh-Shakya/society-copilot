-- Migration: product prices, signup targets, standing approval
-- docs/superpowers/specs/2026-11-18-dashboard-prices-autosend-design.md
-- Additive only.

alter table public.product add column if not exists price_pence integer;
alter table public.product add column if not exists active boolean not null default true;
alter table public.product add column if not exists external_sales_id text;

alter table public.purchase add column if not exists price_pence integer;

alter table public.club add column if not exists signup_target integer not null default 20;
alter table public.club add column if not exists signup_min integer not null default 15;
alter table public.club add column if not exists chase_auto_send_paused boolean not null default false;

alter table public.person add column if not exists chase_auto_approved_at timestamptz;
alter table public.person add column if not exists chase_auto_approved_by text;

alter table public.chase_email add column if not exists auto_approved boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'product_price_pence_check' and conrelid = 'public.product'::regclass) then
    alter table public.product add constraint product_price_pence_check check (price_pence is null or price_pence >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_price_pence_check' and conrelid = 'public.purchase'::regclass) then
    alter table public.purchase add constraint purchase_price_pence_check check (price_pence is null or price_pence >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'club_signup_targets_check' and conrelid = 'public.club'::regclass) then
    alter table public.club add constraint club_signup_targets_check check (signup_min >= 0 and signup_target >= signup_min);
  end if;
end $$;

create unique index if not exists product_club_external_sales_id_key
  on public.product (club_id, external_sales_id) where external_sales_id is not null;
