# CSV Attendance Import (eActivities API Fail-Safe) — Design

Status: approved (2026-10-09)

## Context

`lib/eactivities/client.ts`'s auth bug is fixed (2026-10-03), but a separate,
real server-side problem remains on Imperial's end: `GET /csp/014/whatson`,
`/csp/014/signups`, and `/csp/014/profileentry` all return `HTTP 500` with a
SOAP-style fault, even with correct auth — while `/csp/014`, `/products`, and
`/reports/members` work fine with the same credentials. A report has been
sent to the Union; there's no ETA on a fix.

This blocks **both** halves of the attendance-tracking feature that depend
on `whatson`/`signups`:
- The scheduled/manual sync (`syncSessionAttendance`, Phase 2) — can't fetch
  a signup's roster.
- `/sessions/new` itself (task 3.0) — can't list events or their attached
  signups to bind a session to one in the first place.

Sessions start next week (Wed 6–8pm Judo, Sun 4–6pm Judo, Sun 6–8pm BJJ, Union
Gym, top floor Union Building, SW7 2BB) regardless of whether the Union fixes
this in time. This design is the fail-safe: eActivities' own **admin
dashboard** (the human-facing website, not the broken API) still exports a
CSV of a signup's attendee roster. This feature lets an admin create a
session and populate its roster from that export, with no eActivities API
calls anywhere in the path.

This is additive, not a replacement — once/if the Union fixes the API, the
existing `/sessions/new` + sync flow keeps working as-is. Both paths can
coexist indefinitely; an admin picks whichever currently works.

## Decisions already made (by the user, before this doc)

- **Scope for now**: CSV import only. A member self-serve sign-up/login flow
  was discussed as a longer-term feature but deferred — it solves a
  different problem (members checking themselves in) than this one (admins
  need *a* way to record attendance *right now*, regardless of the API).
- **Session creation is fully manual here**: title, date, and time are typed
  in directly by the admin. No eActivities call of any kind — this path must
  work even if the API never comes back. `eactivities_event_id` /
  `eactivities_signup_id` are left `null` on sessions created this way.
- **The CSV's `Date` column is the signup date, not the event date** — it's
  genuinely different per row (people sign up on different days for the same
  event) and is not used for anything in this design. It's read but not
  persisted; the session's real date/time comes only from the admin's form
  input.
- **Identity matching is email-only.** No CID-based matching, unlike the
  live-sync path (`lib/attendance/sync.ts`'s `findOrCreatePerson`). Reasons:
  the CSV's `CID/Card Number` column is ambiguous (sample values are 7
  digits; Imperial CIDs are documented as 8) and non-student members (BJJ/
  Judo taster attendees, guests) often have no CID at all. The raw value is
  stored for audit but never used to look up or merge people. Name
  (`First Name`/`Surname`) is stored as `full_name` but is not a match key
  either — email alone decides whether a row is an existing person or a new
  one.
- **Blank `Attended` column means unknown, not attended.** Every row in the
  real export has this column blank. Rows import with `attended: false`; an
  admin ticks people on the normal attendance screen afterward, same
  mechanism as any other session. This is a deliberate asymmetry with the
  live sync path, which defaults new rows to `attended: true` (the table's
  column default) — see "Known inconsistency" below.
- **No cross-row date validation.** Earlier drafts of this design assumed
  `Date` was the event date and would reject a file containing more than one
  distinct value. That assumption was wrong (see above) and the check is
  dropped entirely.

## Data model

One migration, additive only:

```sql
-- supabase/migrations/20261009xxxxxx_add_csv_import_attendance_source.sql
alter table public.attendance_record drop constraint attendance_record_source_check;
alter table public.attendance_record add constraint attendance_record_source_check
  check (source in ('signup_sync','manual_tick','walk_in','csv_import'));
```

`'csv_import'` is a new, distinct source — not reused `'signup_sync'` or
`'manual_tick'` — so the audit trail honestly shows this row came from a
hand-uploaded export, not the live API or an admin's individual tick.
Mirrors the existing pattern of `source` as a truthful provenance tag (see
the `SOURCE_LABEL` map in `attendance-screen.tsx`).

TypeScript touch points that enumerate this union and need the new value
added:
- `AttendanceRow["source"]` in `lib/attendance/queries.ts`
- `SOURCE_LABEL` in `components/attendance/attendance-screen.tsx` (new
  label, e.g. `"CSV import"`)

No other schema changes. `session.eactivities_signup_id` / `_event_id`
simply stay `null` for sessions created this way — the column was already
nullable (see `20260914212840_alter_session_add_eactivities_signup_binding.sql`).

## Components

### 1. Parser — `lib/csv-import/parser.ts`

Mirrors the shape of `lib/xlsx/parser.ts` (same `xlsx` package — it parses
CSV as well as XLSX, so no new dependency) but a deliberately different
failure policy, explained below.

```ts
export interface AttendeeRow {
  firstName: string;
  surname: string;
  email: string;
  rawCidOrCardNumber: string | null; // stored for audit, never matched on
}

export interface ParseAttendeeCsvResult {
  rows: AttendeeRow[];
  rowErrors: Array<{ row: number; message: string }>; // 1-indexed, header excluded
}

export function parseAttendeeCsv(buffer: Buffer): ParseAttendeeCsvResult
```

Required columns (header match, case-insensitive, extra columns ignored):
`First Name`, `Surname`, `Email`. A row missing any of these — or with an
`Email` that fails basic email validation — is **not** silently skipped; it
produces a `rowErrors` entry naming the row number and the problem.

**Deliberate deviation from `parseXlsxFile`'s policy** (skip-and-count
invalid rows, ingest the rest): this importer is low-volume (tens of rows,
one admin, one click) and feeds `person`/`attendance_record` directly rather
than a dedup'd purchase-matching pipeline — a silently-dropped row here means
a real person's attendance just doesn't exist anywhere, with no trace. The
caller treats any `rowErrors` as a reason to reject the whole upload (see
below) rather than partially importing.

### 2. Server Action — `lib/csv-import/actions.ts`

```ts
"use server";

const createSessionFromCsvSchema = z.object({
  title: z.string().min(1).max(200),
  startsAt: z.string(), // local datetime from a <input type="datetime-local">
});

export async function createSessionFromCsv(
  input: z.infer<typeof createSessionFromCsvSchema>,
  formData: FormData
): Promise<{ success: boolean; message: string; sessionId?: string }>
```

Flow:
1. `requireAdmin()` first (same convention as every other action in
   `lib/attendance/actions.ts` and `lib/xlsx/uploader.ts`).
2. Validate `title`/`startsAt`; read the uploaded file from `formData`,
   reject non-`.csv` by extension (mirrors `uploadXlsx`'s `.xlsx` check).
3. `parseAttendeeCsv(buffer)`. If `rowErrors.length > 0`, return
   `{ success: false, message: "<n> row(s) failed: row 4: missing email; row 9: missing surname" }`
   — **nothing is written**. The admin fixes the file and re-uploads; there
   is no partial-import state to reconcile.
4. If `rows.length === 0` (empty file past the header), fail the same way
   with a clear message — don't silently create an empty session.
5. Insert the `session` row (`title`, `starts_at`, both eActivities columns
   `null`).
6. For each row: look up `person` by `lower(email)` (same pattern as
   `findOrCreatePerson` in `lib/attendance/sync.ts`, minus the CID branch);
   create if not found (`identity_confidence: 'confirmed'` — the email came
   from eActivities' own signup form, same trust level the live-sync path
   already assigns to API-sourced emails, just hand-exported instead of
   fetched). Then `insert` (not `upsert` — this is a brand-new session, so
   there's no existing row to conflict with) an `attendance_record`:
   `{ person_id, session_id, source: 'csv_import', attended: false }`.
7. Return `{ success: true, sessionId, message: "Imported N attendees" }`.

Steps 5–6 are not wrapped in an explicit SQL transaction (no existing code
in this codebase uses one — Supabase's JS client doesn't expose multi-
statement transactions directly, and every other multi-step write here,
e.g. `createSessionFromSignup`, accepts the same partial-failure risk). If a
person-lookup or attendance-insert fails partway through, the session and
whatever rows succeeded so far remain — the action returns an error, and the
admin can re-run the same upload; already-imported people won't be
duplicated (matched by email) but **will** get a second `attendance_record`
inserted for the same session if the first partial attempt already created
one for them, since this uses `insert` not `upsert` on a new session (no
`UNIQUE(person_id, session_id)` conflict to protect against on a true
re-run). This is a known, accepted gap for a low-volume, one-shot admin
action — not worth an idempotency key for a few-rows-at-a-time manual upload.

### 3. UI — `/sessions/import` (new page) + `components/attendance/csv-importer.tsx`

New page, admin-gated like every other page under `/sessions` and `/admin`.
Form: `Title` text input, a `datetime-local` input for the session's actual
start time, a file input restricted to `.csv`, Submit. On success, redirect
to `/sessions/[sessionId]` (the normal attendance screen — ticking proceeds
exactly as it would for any other session). On failure, show the error
message inline (not just a toast — row-level errors can be a multi-line
list, worth leaving visible to copy/reference while fixing the file).

Linked from `/sessions`' header alongside the existing "New session" button
— e.g. "New session (eActivities)" vs. "New session (CSV import)" — so an
admin isn't guessing which path currently works.

## Known inconsistency (flagged, not fixed here)

The live sync path (`syncSessionAttendance`) inserts attendance rows with no
explicit `attended` value, so they default to the column's `true` default —
i.e., "on the signup list" is presumed attended until someone unticks it.
This import defaults to `attended: false` instead, per your explicit call
(blank `Attended` column means unknown). The two paths now disagree on what
"freshly imported, not yet reviewed" means. This is intentional per your
decision, not a bug, but worth knowing if the two attendance counts ever
look inconsistent to an admin switching between a synced session and an
imported one.

## Testing

- **Unit** (`tests/unit/csv-import-parser.spec.ts`): valid file parses
  correctly; a row missing `Email` produces a `rowErrors` entry with the
  right row number; a row missing `First Name`/`Surname` likewise; extra/
  unrecognized columns (`Date`, `CID/Card Number`, `Event Title`, `Signup
  Title`, `Attended`) are read without error and don't affect output;
  multiple distinct `Date` values in one file do **not** produce an error.
- **Integration** (`tests/integration/csv-import.spec.ts`): a full upload
  creates one session with the given title/start time and one
  `attendance_record` per row, all `source: 'csv_import'`, all
  `attended: false`; a row whose email matches an existing `person` reuses
  that person instead of creating a duplicate; an upload containing any
  invalid row creates nothing at all (no orphaned session).

## Non-goals (explicitly out of scope for this design)

- Member self-serve sign-up/login (deferred, separate future design).
- Deduplicating/merging people by anything other than exact email match.
- Persisting the CSV's signup-date column anywhere.
- Any retry/idempotency mechanism beyond "re-run the whole upload if it
  failed outright" (see Server Action step 6 above).
