-- One-off mock data for local UI exploration. Not a migration (data, not
-- schema) -- run manually via `mcp__supabase__execute_sql` or the Supabase
-- SQL editor when you want a richer dataset to click through. Safe to
-- re-run: every row uses a fixed UUID and every INSERT is idempotent
-- (ON CONFLICT DO NOTHING / DO UPDATE), so re-running just refreshes it
-- rather than duplicating rows. Dates are relative to "today" ~2026-09-22;
-- adjust if you run this much later and want the 7-day chase threshold /
-- "recent" framing to still make sense.

-- Products ------------------------------------------------------------
insert into public.product (id, name, kind, covers_sessions, covers_days) values
  ('11111111-1111-4111-8111-111111111101', 'Single Session Pass', 'session_pass', 1, null),
  ('11111111-1111-4111-8111-111111111102', 'Term Pass', 'term_pass', null, 70),
  ('11111111-1111-4111-8111-111111111103', 'Annual Pass', 'annual_pass', null, 365)
on conflict (id) do update set
  name = excluded.name, kind = excluded.kind,
  covers_sessions = excluded.covers_sessions, covers_days = excluded.covers_days;

-- Sessions --------------------------------------------------------------
insert into public.session (id, title, starts_at) values
  ('22222222-2222-4222-8222-222222222201', 'Beginners Judo — Week 1', '2026-08-25 18:00:00+00'),
  ('22222222-2222-4222-8222-222222222202', 'Beginners Judo — Week 2', '2026-09-01 18:00:00+00'),
  ('22222222-2222-4222-8222-222222222203', 'Beginners Judo — Week 3', '2026-09-08 18:00:00+00'),
  ('22222222-2222-4222-8222-222222222204', 'Beginners Judo — Week 4', '2026-09-15 18:00:00+00'),
  ('22222222-2222-4222-8222-222222222205', 'Open Mat / Sparring Night', '2026-09-29 18:00:00+00')
on conflict (id) do update set title = excluded.title, starts_at = excluded.starts_at;

-- People ------------------------------------------------------------
insert into public.person
  (id, cid, shortcode, email, full_name, is_student, identity_confidence, consent_to_reinvite, is_exempt, exempt_set_by, exempt_set_at, exempt_reason)
values
  ('33333333-3333-4333-8333-222222223301', '01234501', 'ac2201', 'alice.chen23@ic.ac.uk', 'Alice Chen', true, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223302', '01234502', 'bo2201', 'ben.okafor23@ic.ac.uk', 'Ben Okafor', true, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223303', '01234503', 'ps2201', 'priya.sharma23@ic.ac.uk', 'Priya Sharma', true, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223304', '01234504', 'tr2201', 'tom.reynolds23@ic.ac.uk', 'Tom Reynolds', true, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223305', '01234505', 'yt2201', 'yuki.tanaka23@ic.ac.uk', 'Yuki Tanaka', true, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223306', null, null, 'sofia.marino@gmail.com', 'Sofia Marino', false, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223307', '01234507', 'do2201', 'daniel.osei23@ic.ac.uk', 'Daniel Osei', true, 'confirmed', 'not_asked', true, 'ss5123@ic.ac.uk', now(), 'Committee member — free'),
  ('33333333-3333-4333-8333-222222223308', '01234508', 'gl2401', 'grace.lindqvist24@imperial.ac.uk', 'Grace Lindqvist', true, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223309', null, null, 'marcus.webb.walkin@gmail.com', 'Marcus Webb', true, 'provisional', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223310', null, null, 'elena.popescu@outlook.com', 'Elena Popescu', false, 'confirmed', 'not_asked', false, null, null, null),
  ('33333333-3333-4333-8333-222222223311', '01234511', 'ah2201', 'ahmed.hassan23@ic.ac.uk', 'Ahmed Hassan', true, 'confirmed', 'opted_out', false, null, null, null),
  ('33333333-3333-4333-8333-222222223312', '01234512', 'cb2501', 'chloe.bennett25@ic.ac.uk', 'Chloe Bennett', true, 'confirmed', 'not_asked', false, null, null, null)
on conflict (id) do update set
  cid = excluded.cid, shortcode = excluded.shortcode, email = excluded.email,
  full_name = excluded.full_name, is_student = excluded.is_student,
  identity_confidence = excluded.identity_confidence, consent_to_reinvite = excluded.consent_to_reinvite,
  is_exempt = excluded.is_exempt, exempt_set_by = excluded.exempt_set_by,
  exempt_set_at = excluded.exempt_set_at, exempt_reason = excluded.exempt_reason;

-- Attendance ----------------------------------------------------------
-- (person, session, attended, source)
insert into public.attendance_record (person_id, session_id, attended, source) values
  -- Alice: attends every week, no purchase -> free trial (wk1) + 3 unpaid
  ('33333333-3333-4333-8333-222222223301', '22222222-2222-4222-8222-222222222201', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223301', '22222222-2222-4222-8222-222222222202', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223301', '22222222-2222-4222-8222-222222222203', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223301', '22222222-2222-4222-8222-222222222204', true, 'signup_sync'),
  -- Ben: wk1 (free trial) + wk2 (unpaid until session-pass waiver below)
  ('33333333-3333-4333-8333-222222223302', '22222222-2222-4222-8222-222222222201', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223302', '22222222-2222-4222-8222-222222222202', true, 'signup_sync'),
  -- Priya: wk1 (free trial) + wk2/wk3/wk4 (covered by term pass below)
  ('33333333-3333-4333-8333-222222223303', '22222222-2222-4222-8222-222222222201', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223303', '22222222-2222-4222-8222-222222222202', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223303', '22222222-2222-4222-8222-222222222203', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223303', '22222222-2222-4222-8222-222222222204', true, 'signup_sync'),
  -- Tom: wk1 (free trial) + wk2 (unpaid, real debt) + wk4 no-show (doesn't count)
  ('33333333-3333-4333-8333-222222223304', '22222222-2222-4222-8222-222222222201', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223304', '22222222-2222-4222-8222-222222222202', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223304', '22222222-2222-4222-8222-222222222204', false, 'signup_sync'),
  -- Yuki: wk1 (free trial), skips wk2, wk3 (unpaid)
  ('33333333-3333-4333-8333-222222223305', '22222222-2222-4222-8222-222222222201', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223305', '22222222-2222-4222-8222-222222222203', true, 'signup_sync'),
  -- Sofia (external): wk2 (free trial), wk3 + wk4 (unpaid)
  ('33333333-3333-4333-8333-222222223306', '22222222-2222-4222-8222-222222222202', true, 'walk_in'),
  ('33333333-3333-4333-8333-222222223306', '22222222-2222-4222-8222-222222222203', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223306', '22222222-2222-4222-8222-222222222204', true, 'signup_sync'),
  -- Daniel (exempt): attends every week, would be debt if not exempt
  ('33333333-3333-4333-8333-222222223307', '22222222-2222-4222-8222-222222222201', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223307', '22222222-2222-4222-8222-222222222202', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223307', '22222222-2222-4222-8222-222222222203', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223307', '22222222-2222-4222-8222-222222222204', true, 'signup_sync'),
  -- Grace: wk3 (free trial), wk4 (unpaid, right at the chase threshold edge)
  ('33333333-3333-4333-8333-222222223308', '22222222-2222-4222-8222-222222222203', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223308', '22222222-2222-4222-8222-222222222204', true, 'signup_sync'),
  -- Marcus: single walk-in, provisional identity, free trial only
  ('33333333-3333-4333-8333-222222223309', '22222222-2222-4222-8222-222222222201', true, 'walk_in'),
  -- Elena: wk4 only (free trial, no debt) despite having bought an annual pass
  ('33333333-3333-4333-8333-222222223310', '22222222-2222-4222-8222-222222222204', true, 'signup_sync'),
  -- Ahmed: wk1 (free trial), wk2 (unpaid)
  ('33333333-3333-4333-8333-222222223311', '22222222-2222-4222-8222-222222222201', true, 'signup_sync'),
  ('33333333-3333-4333-8333-222222223311', '22222222-2222-4222-8222-222222222202', true, 'signup_sync'),
  -- Chloe: brand new, wk4 only (free trial, no debt)
  ('33333333-3333-4333-8333-222222223312', '22222222-2222-4222-8222-222222222204', true, 'signup_sync')
on conflict (person_id, session_id) do update set attended = excluded.attended, source = excluded.source;

-- Purchases -------------------------------------------------------------
insert into public.purchase
  (id, person_id, product_id, source, source_row_id, raw_member_type, purchased_at, match_status, raw_person_name, raw_email, raw_cid)
values
  -- Ben buys a single-session pass after wk2 -> waives that one debt row
  ('44444444-4444-4444-8444-444444444401', '33333333-3333-4333-8333-222222223302',
   '11111111-1111-4111-8111-111111111101', 'xlsx_upload', 'seed-row-1', 'Student',
   '2026-09-10 00:00:00+00', 'cid_matched', 'Ben Okafor', 'ben.okafor23@ic.ac.uk', '01234502'),
  -- Priya buys a term pass right after wk1 -> covers wk2 retroactively and
  -- wk3/wk4 going forward (70-day window from purchase date)
  ('44444444-4444-4444-8444-444444444402', '33333333-3333-4333-8333-222222223303',
   '11111111-1111-4111-8111-111111111102', 'xlsx_upload', 'seed-row-2', 'Student',
   '2026-08-31 00:00:00+00', 'cid_matched', 'Priya Sharma', 'priya.sharma23@ic.ac.uk', '01234503'),
  -- Elena buys an annual pass (mostly to show a purchase with light/no debt)
  ('44444444-4444-4444-8444-444444444404', '33333333-3333-4333-8333-222222223310',
   '11111111-1111-4111-8111-111111111103', 'xlsx_upload', 'seed-row-4', 'External',
   '2026-09-15 00:00:00+00', 'cid_matched', 'Elena Popescu', 'elena.popescu@outlook.com', null),
  -- An unmatched row, for the manual-match queue UI
  ('44444444-4444-4444-8444-444444444403', null,
   '11111111-1111-4111-8111-111111111101', 'xlsx_upload', 'seed-row-3', 'Student',
   '2026-09-12 00:00:00+00', 'unmatched', 'J. Kowalski', 'j.kowalski24@ic.ac.uk', '01234599')
on conflict (id) do update set
  person_id = excluded.person_id, product_id = excluded.product_id, purchased_at = excluded.purchased_at,
  match_status = excluded.match_status, raw_person_name = excluded.raw_person_name,
  raw_email = excluded.raw_email, raw_cid = excluded.raw_cid;

-- Apply waivers for the two matched purchases that are meant to actually
-- clear debt (same RPC the real purchase-matching flow calls).
select public.apply_purchase_waiver('44444444-4444-4444-8444-444444444401');
select public.apply_purchase_waiver('44444444-4444-4444-8444-444444444402');
