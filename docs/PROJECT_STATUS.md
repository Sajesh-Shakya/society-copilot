# Project Status — Society Ops Copilot

_Last updated: 2026-10-16. This is a living summary, not a spec. For the
full rationale behind any decision below, the linked spec/plan docs are
the source of truth — update this file whenever a decision here goes
stale, but don't treat it as authoritative over them._

## What this is

An ops tool for Imperial College Judo & BJJ: attendance tracking,
payment/debt chasing, and purchase logging. Built fast (originally a
hackathon MVP), now in active beta use by the club's committee.

**Stack:** Next.js App Router + TypeScript, Supabase (Postgres, Auth,
Realtime), Vercel (hosting + cron), Resend (email).

## Where to look for more detail

- `specs/attendance-payment-chasing/` — the original attendance/debt/chase
  design (requirements.md, design.md, tasks.md). Still the backbone of
  that whole feature area.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — later
  features' design docs and implementation plans (admin auth, purchase
  ingestion, debt calculation, chase email sending, CSV attendance
  import). Each one explains *why*, not just *what*.
- `core/INTEGRATIONS.md` — the eActivities API's known failure modes and
  auth details.
- Git history — every non-trivial change has an explanatory commit
  message; `git log --oneline` is often faster than guessing.

## Current state by feature area

### Authentication

Password-based (not magic link — switched 2026-09-22), gated by an
`admin_allowlist` table checked on every Server Action call via
`requireAdmin()` (`lib/auth/require-admin.ts`). Binary access, no roles.
Accounts are provisioned out-of-band (`scripts/create-admin.ts` or
directly via Supabase). Multiple people can share one login
simultaneously with no conflict — Supabase Auth doesn't limit concurrent
sessions per account, so separate logins per committee member are a
nice-to-have, not a requirement.

### Attendance tracking

Two independent paths to populate a session's roster:

1. **eActivities live sync** (`/sessions/new`, `lib/attendance/sync.ts`)
   — the originally-designed path. **Currently broken**: the
   eActivities API's `whatson`/`signups`/`profileentry` endpoints return
   HTTP 500 regardless of auth method (confirmed via multiple auth
   schemes, reported to the Union, no ETA). `/CSP`, `/products`, and
   `/reports/members` still work fine with the same credentials.
2. **CSV import fail-safe** (`/sessions/import`,
   `lib/csv-import/`) — the path actually in use while the above is
   down. An admin exports the attendee roster from eActivities' own
   human-facing dashboard and uploads it. Also supports re-syncing an
   existing session's roster from a fresh export (adds new signups,
   removes anyone who's un-signed-up — but only if they're not yet
   marked attended and weren't manually added; see
   `docs/superpowers/specs/2026-10-09-csv-attendance-import-design.md`
   and the sync behavior added 2026-10-13).

Either path converges on the same `attendance_record` table and the same
attendance screen (`/sessions/[id]`), with a `source` column (
`signup_sync` | `manual_tick` | `walk_in` | `csv_import`) as an honest
provenance tag — **ticking someone's attendance never overwrites their
recorded source** (fixed 2026-10-13; it used to silently relabel a
`csv_import` row as `manual_tick` the moment anyone ticked it, which
defeated the point of recording provenance at all).

Multiple admins can tick attendance on the same session simultaneously —
Supabase Realtime is enabled on `attendance_record` (was wired in the
UI from the start but the table was never added to the realtime
publication until 2026-10-13, so it silently did nothing before then).

A session can be soft-cancelled (`cancelled_at`) without deleting any
data, for when an event gets called off.

Walk-ins (`components/attendance/add-attendee.tsx`) capture an optional
CID instead of the old "shortcode" field (shortcode was written but
never read anywhere; CID is what purchase matching actually uses).
External/non-member guests can't sign up via eActivities at all, so
walk-in is their only path onto a roster — they can still buy session
passes separately.

### Purchase / payment logging

Admin uploads an XLSX export (`/admin/purchases`,
`lib/purchase/`, `lib/xlsx/parser.ts`). The real export has **no
product/pass-type column and no email column** — just Name, Student ID
(CID), Member Type, Date Purchased. So:

- The admin picks which pass the whole file is for from a dropdown
  before uploading (every row in the file is stamped with that
  `productId`) — there's no way to read it from the file.
- Identity matching (`lib/purchase/matcher.ts`) tries, in order: exact
  CID match → (if the CID-bearing buyer is a student, stop here, no
  weaker fallback — a wrong auto-match misattributes a real payment) →
  exact email match → exact-and-unambiguous name match (last resort, for
  external/non-member buyers who have neither CID nor email in the
  export; two people sharing a name stays unmatched rather than guessed).

**Root cause fixed 2026-10-16:** `person.cid` was never actually
populated for anyone (the live eActivities sync that would set it has
been unused since the CSV fail-safe took over, and CSV import
deliberately never wrote it — see its design doc). With nothing to
CID-match against, nearly every purchase fell through to `unmatched`.
Both CSV import and the eActivities sync now backfill `person.cid` once
a person is resolved by email (never overwriting an existing value —
this doesn't change *how* people are matched/merged during import,
still email-only; it just stops leaving the field empty for everyone).
A one-time backfill + re-match was run live against production data.

**Pass expiry:** `product.covers_until` is an absolute calendar cutoff
(added 2026-10-14) — necessary because these passes expire on fixed
dates (e.g. Term 1 Pass always expires 1 Jan 2027) regardless of when
bought, which the older `covers_days` (N days after purchase) field
can't express without over- or under-covering depending on purchase
timing. Applies to every pass kind, including single/batch session
passes. The 6 real pass types are seeded in `product`; exact cutoff
dates were assumed from a verbal description and may need correcting —
see the seeding migration's comment
(`supabase/migrations/20261014090000_add_covers_until_and_seed_passes.sql`).

**First-session-free** is automatic: the `outstanding_attendance` DB
view excludes each person's chronologically-earliest *attended* session
from debt entirely. No flag, no admin action, immune to no-shows.

**Known gap, not yet built:** there's no "stored credit" mechanism for a
session/batch pass bought *before* attending anything — a purchase only
waives debt that's already outstanding at the moment it's ingested. If
someone pre-pays for a future session, nothing currently reconciles that
against the attendance record created later. Flagged by the final review
of the CSV-import plan; not addressed since (low volume, admin can spot
and fix manually for now).

### Payment chasing

`lib/chase/` generates, admin-approves, and sends payment-reminder
emails via Resend (`lib/email/resend-adapter.ts`). Real end-to-end send
verified 2026-10-13 (generate → approve → send, through the actual
production code path, not a mocked adapter). Sender display name is
"Imperial Judo & BJJ" (the underlying address is a personal domain,
already verified with Resend and proven to deliver — changing domains
wasn't worth the cost/risk, just the display name mattered).

## Notable decisions and their rationale (the non-obvious ones)

- **CSV import, not fixing the API**: the Union's API bug has no ETA and
  sessions couldn't wait, so a fail-safe using eActivities' own
  human-facing export was built instead of blocking on a third party.
- **CID trust reversed**: the original attendance-CSV design doc
  distrusted the CID/Card Number column as "ambiguous" (observed 7-digit
  sample vs 8-digit real Imperial CIDs). Checked empirically on
  2026-10-16: it's reliably a clean 8-digit CID once zero-padding is
  accounted for (Excel numeric cells drop leading zeros — see
  `normalizeCid` in `lib/utils.ts`, applied everywhere a CID is parsed,
  stored, or compared). CID is now trusted for backfilling and purchase
  matching, while still **not** being used to merge/match identity during
  CSV import itself (that stays email-only, unchanged).
- **One shared `FilePickerButton` component**
  (`components/ui/file-picker-button.tsx`): three separate upload
  surfaces each independently hand-rolled (and each independently had to
  fix) the same two bugs — a bare `<input type="file">` rendering as an
  easy-to-miss browser-default control, and mobile browsers (notably iOS
  Safari) refusing to open the picker for a `display:none` input.
  Centralized so a fourth upload surface doesn't regress the same way.
- **Soft-delete, not hard-delete, for cancelled sessions**: preserves any
  roster/attendance data already attached rather than losing it.

## Known open items

- **Mobile file picker**: fixed the `display:none` issue (switched to
  `sr-only`), but the user has reported it may still not work on their
  phone after that fix. Not yet root-caused further — manual "Add
  attendee" is the fallback in the meantime.
- **Term 2 Pass expiry date** is an assumption (30 Apr 2027) from a
  verbal description, not confirmed exactly.
- **Purchases admin page** (`/admin/purchases`) only showed Source/
  Status/Date — no name, email, or CID — making an unmatched row
  undebuggable. Being fixed alongside this doc (2026-10-16).
- **eActivities live sync**: still broken, no ETA from the Union.
