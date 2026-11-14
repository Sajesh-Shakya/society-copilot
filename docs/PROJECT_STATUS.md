# Project Status — Society Ops Copilot

_Last updated: 2026-11-13. This is a living summary, not a spec. For the
full rationale behind any decision below, the linked spec/plan docs are
the source of truth — update this file whenever a decision here goes
stale, but don't treat it as authoritative over them._

## What this is

A multi-tenant ops tool for Imperial College clubs: attendance tracking,
payment/debt chasing, and purchase logging. Built fast (originally a
hackathon MVP for Judo & BJJ), now in active beta use by that club's
committee, and extended (2026-11) to support any number of Imperial clubs
sharing the same app/database — Taekwondo is the second real club onboarded.

**Stack:** Next.js App Router + TypeScript, Supabase (Postgres, Auth,
Realtime), Vercel (hosting + cron), Resend (email).

## Where to look for more detail

- `specs/attendance-payment-chasing/` — the original attendance/debt/chase
  design (requirements.md, design.md, tasks.md). Still the backbone of
  that whole feature area.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — later
  features' design docs and implementation plans (admin auth, purchase
  ingestion, debt calculation, chase email sending, CSV attendance
  import, multi-tenancy, per-club eActivities credentials). Each one
  explains *why*, not just *what*.
- `core/INTEGRATIONS.md` — the eActivities API's known failure modes and
  auth details.
- Git history — every non-trivial change has an explanatory commit
  message; `git log --oneline` is often faster than guessing.

## Multi-tenancy (2026-11)

The app now serves multiple clubs from one shared database, each row
tagged with `club_id`. Built across four plans:

- **Plan 1** — schema foundation: `club`, `admin`, and `club_credential`
  tables; `club_id` added to every core table with per-club uniqueness
  constraints.
- **Plan 2a** — club-aware routing (`/club/[clubSlug]/...`) and auth
  (`requireAdmin(clubSlug)` in `lib/auth/require-admin.ts`, resolving the
  club and checking `admin` in one call, identical error for "unknown
  club" and "not an admin" so the slug space can't be enumerated).
  `createClubScopedClient(clubId)` (`lib/supabase/club-scoped.ts`)
  wraps the service-role client, auto-stamping/filtering `club_id` on
  every query for an allowlisted set of tables — the structural guardrail
  that makes scoping load-bearing instead of remembered per call site.
- **Plan 2b-1** — DB-layer migrations: composite same-club foreign keys
  (e.g. `attendance_record(person_id, club_id) -> person`), per-club
  product uniqueness, `purchase_upload.club_id`, and the three
  functions/views that needed club-aware SQL rather than a post-hoc
  filter (`search_person_by_name`, `toggle_attendance`,
  `reapply_waivers_for_everyone_with_debt`, the two debt views).
- **Plan 2b-2** — the application-layer scoping sweep: every `lib/*`
  function and admin page threaded with a real `clubId`, closing
  cross-tenant gaps the DB layer alone couldn't (purchase matching could
  misattribute a real payment across clubs; the chase-email cron only
  ever processed one hardcoded club; several by-id Server Actions had no
  check that a session/upload/product actually belonged to the caller's
  club). The Plan 1 hotfix that hardcoded everything to Judo
  (`getDefaultClubId`) was deleted once every caller threaded a real
  `clubId` instead.
- **Per-club eActivities credentials (2026-11-12)** — the last
  single-club hardcode. `EACTIVITIES_API_KEY`/`EACTIVITIES_CSP_CODE` env
  vars and the temporary `EACTIVITIES_CLUB_SLUG` gate were replaced by a
  `club_credential` lookup (`lib/eactivities/credentials.ts`); any club
  can now get real eActivities access with one command:
  `node scripts/set-eactivities-credentials.ts <slug> <api-key> <csp-code>`.
  Judo's own credentials were migrated into this table the same way.
  Fixing this also surfaced (and closed) a pre-existing cross-tenant gap
  in `app/club/[clubSlug]/sessions/new/page.tsx` that had no club gate at
  all — any club's admin visiting "New session" got Judo's events via
  the global key, unnoticed because nothing made it loud before.

**Verification before Taekwondo went live**: a two-club manual smoke test
(attendance tick, CSV import, chase approval, purchase ingestion, each
with deliberately colliding email/CID/product-name data between Judo and
Taekwondo) confirmed no cross-club leakage, with all seeded test data
verified deleted afterward. See the Plan 2b-2 session record for the
exact checks run.

**Known gap**: the per-club eActivities credential change itself has
never been exercised end-to-end against the real API (see "eActivities
live sync" below — it's down again) — only against fakes/the DB layer.
Re-run a live smoke test for Judo once the Union's API is reachable,
before fully trusting it.

### Authentication

Password-based (not magic link — switched 2026-09-22), now club-aware:
`requireAdmin(clubSlug)` (`lib/auth/require-admin.ts`) resolves the club
and checks the `admin` table (one row per `(email, club_id)`, so one
person can administer more than one club). The pre-multi-tenancy
`admin_allowlist` table is still written alongside `admin` as a rollback
safety net for one release's worth of margin — not yet removed. Binary
access per club, no roles. Accounts are provisioned out-of-band
(`scripts/create-admin.ts <email> <club-slug>`, or directly via
Supabase). Multiple people can share one login simultaneously with no
conflict — Supabase Auth doesn't limit concurrent sessions per account.

### Attendance tracking

Two independent paths to populate a session's roster, both now
club-scoped:

1. **eActivities live sync** (`/club/[clubSlug]/sessions/new`,
   `lib/attendance/sync.ts`) — the originally-designed path, now reading
   each club's own credentials from `club_credential` instead of a
   single global key (see "Multi-tenancy" above). **Currently broken
   again**: as of 2026-11-13 the Union's eActivities API is reported down
   for the `whatson`/`events` endpoints (no ETA) — a live, external
   outage, not a regression from the credentials change. This echoes an
   earlier 2026-10 outage of the same endpoints that was the original
   reason the CSV fail-safe below exists; check with the Union before
   assuming either cause is still the live one.
2. **CSV import fail-safe** (`/club/[clubSlug]/sessions/import`,
   `lib/csv-import/`) — the path actually in use while the above is
   down. An admin exports the attendee roster from eActivities' own
   human-facing dashboard and uploads it. Also supports re-syncing an
   existing session's roster from a fresh export (adds new signups,
   removes anyone who's un-signed-up — but only if they're not yet
   marked attended and weren't manually added; see
   `docs/superpowers/specs/2026-10-09-csv-attendance-import-design.md`
   and the sync behavior added 2026-10-13).

Either path converges on the same `attendance_record` table and the same
attendance screen (`/club/[clubSlug]/sessions/[id]`), with a `source`
column (`signup_sync` | `manual_tick` | `walk_in` | `csv_import`) as an
honest provenance tag — **ticking someone's attendance never overwrites
their recorded source** (fixed 2026-10-13; it used to silently relabel a
`csv_import` row as `manual_tick` the moment anyone ticked it, which
defeated the point of recording provenance at all).

Multiple admins can tick attendance on the same session simultaneously —
Supabase Realtime is enabled on `attendance_record`, with its RLS policy
scoped by club (an admin of one club can no longer subscribe to another
club's attendance updates, fixed as part of Plan 2a).

A session can be soft-cancelled (`cancelled_at`) without deleting any
data, for when an event gets called off.

Walk-ins (`components/attendance/add-attendee.tsx`) capture an optional
CID instead of the old "shortcode" field (shortcode was written but
never read anywhere; CID is what purchase matching actually uses).
External/non-member guests can't sign up via eActivities at all, so
walk-in is their only path onto a roster — they can still buy session
passes separately. Every by-id attendance action
(`toggleAttendance`, `setSessionCancelled`, `addExistingPersonToSession`,
`createWalkIn`, `triggerManualSync`, `getAttendanceList`) now verifies
the target session actually belongs to the caller's club before acting
on it (`assertSessionBelongsToClub`, added in Plan 2b-2) — closing a
cross-tenant IDOR where one club's admin could otherwise act on another
club's session by guessing/enumerating its id.

### Purchase / payment logging

Admin uploads an XLSX export (`/club/[clubSlug]/admin/purchases`,
`lib/purchase/`, `lib/xlsx/parser.ts`), scoped per club. The real export
has **no product/pass-type column and no email column** — just Name,
Student ID (CID), Member Type, Date Purchased. So:

- The admin picks which pass the whole file is for from a dropdown
  before uploading (every row in the file is stamped with that
  `productId`) — there's no way to read it from the file. Products are
  unique per club (not globally), so two clubs can each have their own
  "Term 1 Pass" without colliding.
- Identity matching (`lib/purchase/matcher.ts`) tries, in order, **within
  the uploading club only**: exact CID match → (if the CID-bearing buyer
  is a student, stop here, no weaker fallback — a wrong auto-match
  misattributes a real payment) → exact email match → exact-and-
  unambiguous name match (last resort, for external/non-member buyers who
  have neither CID nor email in the export; two people sharing a name
  stays unmatched rather than guessed). Before Plan 2b-2, this matching
  had no club filter at all — a purchase uploaded by one club could in
  principle auto-match to a person who belongs to a different club
  purely by email/CID/name coincidence; closed as part of the scoping
  sweep.

**Root cause fixed 2026-10-16:** `person.cid` was never actually
populated for anyone (the live eActivities sync that would set it has
been unused since the CSV fail-safe took over, and CSV import
deliberately never wrote it — see its design doc). With nothing to
CID-match against, nearly every purchase fell through to `unmatched`.
Both CSV import and the eActivities sync now backfill `person.cid` once
a person is resolved (never overwriting an existing value — it just
stops leaving the field empty for everyone). A one-time backfill +
re-match was run live against production data.

**Second instance, 2026-10-25:** CSV import's own identity matching was
*still* email-only at that point (per its original design doc — only the
backfill above had changed). It broke in production: a real person (CID
already on file) signed up again under a different email; email-only
correctly found no match for that email and tried to INSERT a new
person row with their CID; a DB-level unique index on `person.cid`
rejected it (two people can't share a CID); the whole CSV import aborted
partway through, with no transaction boundary to roll back the
already-created session. Fixed by switching CSV import's matching to
CID-first-then-email (mirroring the live-sync path and walk-ins, which
already worked this way) — see the design doc's revision for the full
account, and `lib/csv-import/importer.ts`'s `findOrCreatePersonByEmail`.

**Pass expiry:** `product.covers_until` is an absolute calendar cutoff
(added 2026-10-14) — necessary because these passes expire on fixed
dates (e.g. Term 1 Pass always expires 1 Jan 2027) regardless of when
bought, which the older `covers_days` (N days after purchase) field
can't express without over- or under-covering depending on purchase
timing. Applies to every pass kind, including single/batch session
passes. The 6 real pass types for Judo are seeded in `product`; exact
cutoff dates were assumed from a verbal description and may need
correcting — see the seeding migration's comment
(`supabase/migrations/20261014090000_add_covers_until_and_seed_passes.sql`).

**First-session-free** is automatic: the `outstanding_attendance` DB
view excludes each person's chronologically-earliest *attended* session
from debt entirely, scoped per club. No flag, no admin action, immune to
no-shows.

**Known gap, not yet built:** there's no "stored credit" mechanism for a
session/batch pass bought *before* attending anything — a purchase only
waives debt that's already outstanding at the moment it's ingested. If
someone pre-pays for a future session, nothing currently reconciles that
against the attendance record created later. Flagged by the final review
of the CSV-import plan; not addressed since (low volume, admin can spot
and fix manually for now). A separate safety-net sweep
(`reapplyWaiversForEveryoneWithDebt`, now club-scoped and run per-club by
the weekly cron) catches most of what this would otherwise miss.

### Payment chasing

`lib/chase/` generates, admin-approves, and sends payment-reminder
emails via Resend (`lib/email/resend-adapter.ts`), all club-scoped since
Plan 2b-2. The weekly cron (`app/api/cron/chase-emails/route.ts`) now
loops over every club in its own try/catch, so one club's failure (a bad
row, a transient Resend outage) can't block the others — before this it
only ever processed a single hardcoded club. Real end-to-end send
verified 2026-10-13 for Judo (generate → approve → send, through the
actual production code path, not a mocked adapter); not yet re-verified
for Taekwondo specifically (low volume there so far). Sender display
name is "Imperial Judo & BJJ" for Judo's sends (the underlying address is
a personal domain, already verified with Resend and proven to deliver —
changing domains wasn't worth the cost/risk, just the display name
mattered); Taekwondo's sends currently use the same shared sender
identity — a per-club sender display name/domain hasn't been built.

## Notable decisions and their rationale (the non-obvious ones)

- **Shared database, not per-club schemas**: one canonical Postgres
  schema with a `club_id` column on every tenant-scoped table, rather
  than separate schemas/databases per club — simpler migrations, simpler
  cross-club admin tooling, and the composite-FK backstop
  (Plan 2b-1) gives nearly the same cross-tenant-corruption protection a
  separate schema would, without the operational overhead of N schemas.
- **App-layer scoping + a guardrail client, not full RLS tenant
  isolation**: `createClubScopedClient` auto-filters/stamps `club_id` in
  application code rather than relying solely on Postgres RLS policies
  per tenant. Chosen for how directly it integrates with the existing
  service-role-client codebase; the composite FKs are the DB-level
  backstop for when a scoping fix is missed anyway.
- **CSV import, not fixing the API**: the Union's API bug has no ETA and
  sessions couldn't wait, so a fail-safe using eActivities' own
  human-facing export was built instead of blocking on a third party.
  This has now recurred twice (2026-10 and 2026-11) — treat the live
  sync as fundamentally unreliable, not a one-off outage, when deciding
  how much to invest in it versus the CSV path.
- **CID trust reversed**: the original attendance-CSV design doc
  distrusted the CID/Card Number column as "ambiguous" (observed 7-digit
  sample vs 8-digit real Imperial CIDs). Checked empirically on
  2026-10-16: it's reliably a clean 8-digit CID once zero-padding is
  accounted for (Excel numeric cells drop leading zeros — see
  `normalizeCid` in `lib/utils.ts`, applied everywhere a CID is parsed,
  stored, or compared). CID is now trusted for backfilling, purchase
  matching, AND CSV-import identity matching itself (CID-first-then-
  email, since 2026-10-25 — see the "Second instance" note above).
- **One shared `FilePickerButton` component**
  (`components/ui/file-picker-button.tsx`): three separate upload
  surfaces each independently hand-rolled (and each independently had to
  fix) the same two bugs — a bare `<input type="file">` rendering as an
  easy-to-miss browser-default control, and mobile browsers (notably iOS
  Safari) refusing to open the picker for a `display:none` input.
  Centralized so a fourth upload surface doesn't regress the same way.
- **Soft-delete, not hard-delete, for cancelled sessions**: preserves any
  roster/attendance data already attached rather than losing it.
- **A one-off provisioning script, not an admin UI, for credentials**:
  both admin accounts (`scripts/create-admin.ts`) and eActivities keys
  (`scripts/set-eactivities-credentials.ts`) are provisioned by a
  manually-run script rather than a form in the app — matches this
  MVP's existing security posture (every other secret, Resend key, cron
  secret, sync trigger secret, is a plain env var with no UI either) and
  keeps scope small for something that happens rarely, per club.

## Performance baseline (2026-11-13, navigation-speed)

- **Supabase region**: `eu-west-2` (London), project `society-copilot`
  (ref `gszhsinwewcfyqjixpgu`), from the Supabase MCP `get_project`.
- **Vercel function region: NOT VERIFIED.** The Vercel MCP session had
  expired ("needs you to sign in again") and the local `vercel` CLI token
  is invalid, so the project's region setting could not be read.
  `vercel.json` sets no `regions`, so unless the dashboard overrides it
  the Vercel default applies, which for new projects is `iad1`
  (Washington DC, North America). If so, every function-to-Supabase
  round trip crosses the Atlantic.
- **Baseline durations: NOT RECORDED.** Runtime logs were unreachable for
  the same reason, so there are no measured numbers for
  `GET /club/judo/sessions` or `/club/judo/admin/purchases`. No figures
  are invented here; Task 7 needs a baseline captured (dashboard Logs,
  or `get_runtime_logs` after re-auth) before it can compare.
- **Region decision: `vercel.json` left unchanged.** Adding
  `"regions": ["lhr1"]` is the likely fix (lhr1 = London, next to
  eu-west-2), but it should only go in once the current Vercel region is
  confirmed to be on a different continent.

## Ingestion speed (2026-11-14, ingestion-speed)

- **What changed**: XLSX and CSV ingestion no longer do per-row round
  trips. Already-ingested rows are looked up in chunks and dropped before
  an upload batch is created (a full re-upload leaves no empty batch);
  purchases are inserted in chunks with conflict-ignoring upserts and
  follow-ups (is_student, waivers) run only for rows actually inserted;
  the CSV importer resolves people from one in-memory index and bulk-
  creates the missing ones. `next.config.ts` sets
  `experimental.serverActions.bodySizeLimit: "4mb"` (a 5,000-row export is
  ~1.3 MB, over the 1 MB default; 4 MB stays under Vercel's 4.5 MB request
  cap). The purchases page sets `maxDuration = 60`. Neither the uploader
  component nor `uploadXlsx` enforces its own file-size cap.
- **Measurements** (dev Supabase project, run from this dev machine, so
  network latency differs from the deployed app; 5,000-row synthetic
  XLSX, half the people pre-existing so matching was mixed, all rows
  Student/Public with unique emails and CIDs):
  - First-time upload: parse 0.14 s, already-ingested lookup 2.7 s,
    ingest 117.6 s, total ~120 s (5,000 inserted, 0 errors).
  - Same file again (all duplicates): total ~2.5 s, "Nothing new — all
    5000 were already ingested", no upload batch created.
  - CSV attendance import with 5,000 brand-new people: 2.4 s, 5,000
    imported (single bulk person insert did not truncate or fail).
- **Remaining bottleneck**: the first-time run is dominated by per-
  purchase follow-ups for matched people (an `is_student` update and an
  `apply_purchase_waiver` RPC each, concurrency 5, ~47 ms per matched
  purchase). A 5,000-row first-time upload exceeds `maxDuration = 60`
  and would time out on Vercel; roughly 1,000 matched rows or fewer fit
  (extrapolated from the above, not measured). Batching the follow-ups
  (one set-based waiver call per upload) is the next step if exports
  that large are expected.
- **NOT VERIFIED**: re-upload of the real sales export on the deployed
  app. This needs the user's real export and a preview deploy; the
  numbers above are synthetic and local.

## Known open items

- **eActivities live sync**: down again as of 2026-11-13 (`whatson`/
  `events` endpoints), no ETA from the Union — see "Attendance tracking"
  above. CSV import is the working path in the meantime, for every club.
- **Per-club eActivities credentials never smoke-tested against the real
  API**: the 2026-11-12 credential-lookup change was fully verified
  against fakes and the DB layer, but the live API has been down since
  before that work could be exercised end-to-end. Re-run a real sync for
  Judo once the API is reachable again.
- **Stale references to the retired `EACTIVITIES_API_KEY`/
  `EACTIVITIES_CSP_CODE` env vars**: `components/attendance/session-
  picker.tsx`'s error toast, `.env.example`, `README.md`, and
  `core/INTEGRATIONS.md` still mention them as required — they're dead
  now that credentials live in `club_credential`. Cosmetic, not fixed
  yet.
- **`club_credential.credentials`' shape isn't validated with Zod** —
  `getEactivitiesCredentials` checks field presence by truthiness, not a
  real schema, so a hand-inserted non-string value would pass the check
  and fail later in a less obvious way. Low risk (only touched by a
  script, not user input) but inconsistent with this codebase's usual
  "validate with Zod" convention.
- **Taekwondo's chase emails share Judo's sender display name/domain** —
  no per-club sender identity has been built; low priority while
  Taekwondo's chase volume is low.
- **Mobile file picker**: fixed the `display:none` issue (switched to
  `sr-only`), but the user has reported it may still not work on their
  phone after that fix. Not yet root-caused further — manual "Add
  attendee" is the fallback in the meantime.
- **Term 2 Pass expiry date** is an assumption (30 Apr 2027) from a
  verbal description, not confirmed exactly.
- **`admin_allowlist` not yet removed** — kept alongside the per-club
  `admin` table as a rollback safety net since Plan 2a shipped; due for
  removal once multi-tenancy has run in production for a release without
  needing it.
