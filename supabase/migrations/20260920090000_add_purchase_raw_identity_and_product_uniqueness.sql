-- Migration: persist raw buyer identity on purchase rows; enforce product
-- name uniqueness.
--
-- Fixes two defects found in the final whole-branch review of
-- docs/superpowers/plans/2026-09-19-purchase-ingestion.md:
--
-- 1. Unmatched purchases (match_status = 'unmatched', person_id = null)
--    previously stored no trace of who the buyer was — name/email/cid were
--    validated on the way in but discarded before the insert. tasks.md 4.6's
--    manual-review queue (the whole reason match_status/purchase_match_status_idx
--    exist) has nothing to show an admin without this. Idempotent ingestion
--    also means a re-upload can't "fix" this retroactively (same row hash ->
--    same source_row_id -> counted as a duplicate, never re-inserted).
-- 2. `product` had no uniqueness constraint on `name`, so concurrent ingests
--    resolving the same new product name could each insert a row, silently
--    splitting one product's purchase history across two ids (which would
--    corrupt Phase 5 debt calculation) and making a plain `.maybeSingle()`
--    lookup start erroring (PGRST116, "not exactly one row") on every future
--    ingest referencing that name.

alter table public.purchase
  add column raw_person_name text,
  add column raw_email text,
  add column raw_cid text;

comment on column public.purchase.raw_person_name is
  'Verbatim buyer name from the source row. Populated for every purchase (matched or not); the manual-match queue (tasks.md 4.6) reads this for unmatched rows.';
comment on column public.purchase.raw_email is
  'Verbatim buyer email from the source row, if provided.';
comment on column public.purchase.raw_cid is
  'Verbatim buyer CID from the source row, if provided.';

alter table public.product
  add constraint product_name_unique unique (name);
