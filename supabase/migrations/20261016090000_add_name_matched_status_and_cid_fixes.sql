-- Migration: add 'name_matched' as a valid purchase.match_status value.
--
-- Context: person.cid was never actually populated for anyone, because
-- the live eActivities sync (the only path that ever wrote it) has been
-- broken/unused since the CSV-import fail-safe took over, and CSV import
-- deliberately never wrote person.cid either. With nothing to CID-match
-- against, and the real purchases export having no email column at all,
-- every purchase fell through to 'unmatched'. Application code (see
-- lib/csv-import/importer.ts and lib/attendance/sync.ts) now backfills
-- person.cid going forward, and lib/purchase/matcher.ts adds a cautious,
-- only-when-unambiguous name-match as a last resort (e.g. for external/
-- non-member buyers, who have neither a CID nor an email in the export).
alter table public.purchase drop constraint purchase_match_status_check;
alter table public.purchase add constraint purchase_match_status_check
  check (match_status in ('cid_matched', 'email_matched', 'name_matched', 'manual_matched', 'unmatched'));
