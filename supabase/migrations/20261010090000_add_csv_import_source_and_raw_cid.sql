-- Migration: add csv_import attendance source + raw CID/card-number audit column
-- docs/superpowers/specs/2026-10-09-csv-attendance-import-design.md

alter table public.attendance_record drop constraint attendance_record_source_check;
alter table public.attendance_record add constraint attendance_record_source_check
  check (source in ('signup_sync','manual_tick','walk_in','csv_import'));

alter table public.attendance_record add column raw_cid_or_card_number text;

comment on column public.attendance_record.raw_cid_or_card_number is
  'Raw CID/Card Number value from a csv_import row, kept for audit only -- never used to match/merge person records (see 2026-10-09 design doc). Null for every other source.';
