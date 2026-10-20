-- Migration: track XLSX upload batches, so an accidental wrong-product
-- upload can be corrected (change the product every row in that batch was
-- recorded against) or undone (delete the whole batch) without an admin
-- having to hand-pick individual purchase rows -- there was previously no
-- way to tell which rows came from the same upload at all.
create table public.purchase_upload (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product(id),
  filename text,
  row_count int not null default 0,
  uploaded_by text,                            -- admin email, for audit
  created_at timestamptz not null default now()
);

comment on table public.purchase_upload is
  'One row per XLSX upload batch -- lets an admin change the product a whole upload was recorded against, or undo it entirely, without hand-picking individual purchase rows. See docs/PROJECT_STATUS.md.';

alter table public.purchase add column upload_id uuid references public.purchase_upload(id);
create index purchase_upload_id_idx on public.purchase (upload_id);

comment on column public.purchase.upload_id is
  'Which upload batch this row came from. Null for a Pluto-sourced row, or an XLSX row ingested before this column existed.';

-- RLS: deny-all, same pattern as purchase/product -- all access is
-- server-side via SUPABASE_SECRET_KEY (service_role, bypasses RLS).
alter table public.purchase_upload enable row level security;
alter table public.purchase_upload force row level security;
