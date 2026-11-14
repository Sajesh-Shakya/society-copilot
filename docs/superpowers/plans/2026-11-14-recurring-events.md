# Event End Time + Recurring Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions get an optional end time, an admin can create a weekly recurring series of sessions in one step (optional signup CSV applies to the first occurrence only), and can delete "this and all later events" of a series without losing recorded attendance.

**Architecture:** One additive migration (`session.ends_at`, `session_series`, `session.series_id`). Occurrences are materialised as ordinary `session` rows, so every existing screen keeps working. A pure recurrence module computes Europe/London wall-clock occurrences; pure-ish core functions in `lib/session-series/*` hold the DB logic (no `requireAdmin`, like `lib/csv-import/importer.ts`) and thin `"use server"` actions add the admin check.

**Tech Stack:** Next.js 16 server actions, `createClubScopedClient`, Zod, Postgres/Supabase migrations, Playwright (unit + integration configs). No new dependencies (timezone maths via `Intl.DateTimeFormat`).

**Spec:** `docs/superpowers/specs/2026-11-13-performance-and-recurring-events-design.md` (Project 3)

## Global Constraints

- Weekly recurrence only, ending on a chosen date. No editing a series in place, no other patterns.
- `session.ends_at timestamptz null`; a null `ends_at` (every existing row) means `starts_at + 2h` (`lib/attendance/event-window.ts` already does this). Existing sessions and the eActivities/CSV flows must keep working with no end time given.
- Occurrence times are computed in Europe/London local time: a 19:00 session stays 19:00 local across both clock changes (not +7×24h in UTC).
- A signup CSV given at series creation populates the **first occurrence only**; every other occurrence starts with an empty roster.
- Delete this-and-later: applies to occurrences of the same series with `starts_at >=` the chosen occurrence's. An occurrence with any `attended = true` record is **kept** and listed (it holds attendance and debt history); everything else in the target set is deleted, including future ones. One attended-records query across the whole target set is the guard. Non-series sessions are never touched. Recorded attendance must never be deleted.
- Multi-tenancy: new table `session_series` carries `club_id`, is added to `CLUB_SCOPED_TABLES` in `lib/supabase/club-scoped.ts`, and `session.series_id` uses a same-club composite FK (`(series_id, club_id) references session_series (id, club_id)`), matching `supabase/migrations/20261102090000_add_same_club_foreign_keys.sql`. All DB access through `createClubScopedClient(clubId)`; every new action calls `requireAdmin(clubSlug)` first and `assertSessionBelongsToClub` for any session id taken from the client.
- RLS on the new table: enable + force, deny-all, like `supabase/migrations/20260914150853_create_session_table.sql`.
- Next.js 16 differs from training data (AGENTS.md): read the relevant doc in `node_modules/next/dist/docs/` before writing page/route/server-action code. Any new route under `/club/[clubSlug]` gets a `loading.tsx` using `PageSkeleton` (`components/nav/page-skeleton.tsx`), and navigation links use `PendingLink` (`components/nav/pending-link.tsx`).
- Commit steps follow repo convention and end with the attribution line from the session. Integration tests run against the real dev Supabase project (`playwright.integration.config.ts`, 1 worker) and clean up after themselves (existing pattern: delete `attendance_record` rows, then `session`, then `session_series`, then `person`).
- The migration is additive and nullable, so applying it to the Supabase project before the code is deployed is safe. Applying it to the dev project is done by the controller (Task 1, Step 4), not by implementers.

## Review Focus

- A weekly 19:00 Europe/London series that crosses the last-Sunday-of-October and last-Sunday-of-March clock changes keeps 19:00 local on every occurrence (UTC instants shift by an hour).
- End time at or before the start time, an `until` date before the first start, and an absurdly long series (typo like year 2207) are rejected with a clear message and create nothing.
- Series creation with an invalid or empty CSV creates no series and no sessions; a failure while inserting occurrences leaves no orphan `session_series` row.
- "Delete this and all later" chosen from a middle occurrence leaves earlier occurrences untouched, keeps and lists any later occurrence that has an attended record (even a future one ticked ahead of time), and removes the `session_series` row only when no sessions remain.
- A club-A admin passing a club-B session id (or series member) to the delete/preview actions is refused; nothing in club B changes.

## File Structure

- Create `supabase/migrations/20261114090000_session_end_time_and_series.sql`.
- Modify `lib/supabase/club-scoped.ts` (add `session_series`).
- Create `lib/session-series/recurrence.ts` — pure: `weeklyOccurrences`, `londonWallTimeToUtc`.
- Create `lib/session-series/create.ts` — `createRecurringSeries` (DB logic).
- Create `lib/session-series/delete.ts` — `planSeriesDelete`, `executeSeriesDelete`.
- Create `lib/session-series/actions.ts` — `"use server"`: `createRecurringSeriesAction`, `previewSeriesDeleteAction`, `deleteSeriesFromAction`.
- Create `lib/session-series/upcoming.ts` — pure `limitUpcomingPerSeries`.
- Modify `lib/attendance/queries.ts` (`endsAt`, `seriesId` on both session reads), `lib/attendance/actions.ts` (`createSessionFromSignup` end time), `lib/csv-import/importer.ts` + `actions.ts` (`endsAt` on `createSessionFromCsv`).
- Modify `components/attendance/session-picker.tsx`, `components/attendance/csv-importer.tsx`, `components/attendance/attendance-screen.tsx`, `app/club/[clubSlug]/sessions/page.tsx`.
- Create `app/club/[clubSlug]/sessions/recurring/page.tsx` + `loading.tsx`, `components/attendance/recurring-session-form.tsx`, `components/attendance/series-delete-panel.tsx`.
- Tests: `tests/unit/recurrence.spec.ts`, `tests/unit/upcoming.spec.ts`; integration `tests/integration/session-series-schema.spec.ts`, `session-end-time.spec.ts`, `session-series-create.spec.ts`, `session-series-delete.spec.ts`.

---

### Task 1: Migration and schema guard

**Files:**
- Create: `supabase/migrations/20261114090000_session_end_time_and_series.sql`
- Modify: `lib/supabase/club-scoped.ts`
- Test: `tests/integration/session-series-schema.spec.ts`

**Interfaces:**
- Produces: table `session_series(id uuid pk default gen_random_uuid(), club_id uuid not null references club(id), title text not null, created_at timestamptz not null default now(), unique (id, club_id))`; `session.ends_at timestamptz null` with `check (ends_at is null or ends_at > starts_at)`; `session.series_id uuid null` with FK `(series_id, club_id) → session_series (id, club_id)` (no cascade: deleting a series row that still has sessions must fail); index on `session (series_id, starts_at)`; RLS enabled + forced on `session_series`; `"session_series"` added to `CLUB_SCOPED_TABLES`.

- [ ] **Step 1: Write failing integration tests** in `session-series-schema.spec.ts` (admin client, cleanup in `afterEach`): (a) inserting a `session` with `ends_at` earlier than `starts_at` is rejected, equal is rejected, later is accepted, null is accepted; (b) a `session` in club A with `series_id` of a club B series is rejected by the composite FK; (c) deleting a `session_series` row that still has a session fails; (d) `createClubScopedClient(clubId).from("session_series").insert({ title })` stamps `club_id` and a scoped `select` for the other club does not return it.
- [ ] **Step 2: Run** `npx playwright test --config=playwright.integration.config.ts session-series-schema` — Expected: FAIL (table/columns missing).
- [ ] **Step 3: Write the migration** per the Interfaces block (header comment in the repo's style, referencing the design doc) and add `session_series` to `CLUB_SCOPED_TABLES`. Do NOT apply it to any Supabase project.
- [ ] **Step 4 (controller):** apply the migration to the dev project with the Supabase MCP `apply_migration` (same name/version), then confirm columns with `list_tables`.
- [ ] **Step 5: Run tests** — Expected: PASS. Also run `npx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(db): session end time, session_series, same-club series FK`.

### Task 2: Recurrence maths (pure)

**Files:**
- Create: `lib/session-series/recurrence.ts`
- Test: `tests/unit/recurrence.spec.ts`

**Interfaces:**
- Produces:
  - `const SERIES_TIME_ZONE = "Europe/London"`; `const MAX_OCCURRENCES = 60`.
  - `londonWallTimeToUtc(date: string /* YYYY-MM-DD */, time: string /* HH:mm */): Date` — the instant at which London wall clocks read that date/time. A wall time that does not exist (spring-forward gap) resolves to the instant just after the gap (e.g. 01:30 on 2027-03-28 → 02:30 BST = 01:30Z); an ambiguous time (autumn overlap) resolves to the first (BST) occurrence. Throws on malformed input.
  - `weeklyOccurrences(input: { firstDate: string; startTime: string; endTime: string; untilDate: string }): { startsAt: Date; endsAt: Date }[]` — one per week from `firstDate` while the occurrence date ≤ `untilDate` (inclusive); each `endsAt` is the same London date at `endTime`. Throws `RecurrenceError` (exported class, user-facing `message`) when: `endTime` ≤ `startTime`; `untilDate` < `firstDate`; the series would exceed `MAX_OCCURRENCES`; a date or time is malformed.

- [ ] **Step 1: Write failing unit tests** in `tests/unit/recurrence.spec.ts` (no DB):
  - Weekly 19:00–20:30 from `2026-10-19` until `2026-11-02`: starts are `2026-10-19T18:00Z`, `2026-10-26T19:00Z` (clock went back on 25 Oct), `2026-11-02T19:00Z`; ends are start + 90 min.
  - Spring crossing: from `2027-03-22` weekly until `2027-03-29`: `2027-03-22T19:00Z` then `2027-03-29T18:00Z`.
  - `untilDate` equal to an occurrence date includes it; the day before excludes it.
  - Gap and overlap cases for `londonWallTimeToUtc` as described above; round trip: formatting the result with `Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false, … })` gives back the input for 100 sampled non-edge instants across a year.
  - Rejections: end equal to start, end before start, until before first, 61 weekly occurrences, `"2026-13-01"`, `"7pm"`.
- [ ] **Step 2: Run** `npx playwright test tests/unit/recurrence.spec.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** both functions with `Intl.DateTimeFormat` (`timeZoneName: "longOffset"` or parts-based offset search around the UTC guess); no new dependency; date stepping done on calendar dates (add 7 days to the `YYYY-MM-DD` using UTC arithmetic on a date-only value), never by adding 7×24h to an instant.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sessions): weekly Europe/London occurrence maths`.

### Task 3: End time on sessions end to end

**Files:**
- Modify: `lib/attendance/queries.ts`, `lib/attendance/actions.ts` (`createSessionFromSignup`, `getEventSignups`), `lib/csv-import/importer.ts` (`createSessionFromCsvSchema`, `ImportAttendanceCsvInput`, `importAttendanceCsv`), `lib/csv-import/actions.ts` (`createSessionFromCsv`), `components/attendance/session-picker.tsx`, `components/attendance/csv-importer.tsx`, `components/attendance/attendance-screen.tsx`, `app/club/[clubSlug]/sessions/page.tsx`
- Test: `tests/integration/session-end-time.spec.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `SessionWithAttendance` and `SessionListItem` gain `endsAt: string | null` and `seriesId: string | null`; `createSessionSchema` and `createSessionFromCsvSchema` gain optional `endsAt` (ISO datetime with offset, or omitted/empty = null) and reject an `endsAt` not after `startsAt` with a clear message; `importAttendanceCsv` input gains `endsAt?: string | null` and stores `ends_at`; `getEventSignups` also returns `endsAt` (eActivities `EventEnd`) so the picker prefills the end time; the sessions list passes `endsAt` into `isInPrefetchWindow` (replacing the `endsAt: null` placeholder and its comment); the attendance screen header shows `start – end` when `endsAt` is set (end time only, same day) and just the start otherwise.

- [ ] **Step 1: Write failing integration tests** in `session-end-time.spec.ts`: (a) `importAttendanceCsv({ title, startsAt, endsAt, rows }, clubId)` stores `ends_at`; without `endsAt` stores null; (b) `createSessionFromCsvSchema` rejects `endsAt` ≤ `startsAt` and accepts omitted/empty; (c) `getSessionWithAttendance` and `listRecentSessions` return `endsAt` and `seriesId` (null for legacy rows); (d) a session with a stored `ends_at` 3h after start is reported in the prefetch window at start + 3h30 via `isInPrefetchWindow` fed from the list item (null-end sessions still use start + 2h — keep `tests/unit/event-window.spec.ts` green).
- [ ] **Step 2: Run** `npx playwright test --config=playwright.integration.config.ts session-end-time` — Expected: FAIL.
- [ ] **Step 3: Implement** the interface changes. The CSV form and picker add an optional "Ends at" `datetime-local` input converted to an ISO instant exactly like `startsAt` is today; the picker prefills it from `EventEnd`. Keep the DB write for `createSessionFromSignup` using the same `ends_at` column.
- [ ] **Step 4: Run** the new spec, `tests/integration/session-list.spec.ts`, `csv-import`, `npm run test:unit`, `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sessions): optional event end time through create flows, reads and prefetch window`.

### Task 4: Create a recurring series (core + action)

**Files:**
- Create: `lib/session-series/create.ts`, `lib/session-series/actions.ts`
- Test: `tests/integration/session-series-create.spec.ts`

**Interfaces:**
- Consumes: `weeklyOccurrences`/`RecurrenceError` (Task 2), `syncAttendanceCsv` (existing, `lib/csv-import/importer.ts`), `parseAttendeeCsv`/`isCsvFile` (`lib/csv-import/parser.ts`).
- Produces:
  - `createRecurringSeries(input: { title: string; firstDate: string; startTime: string; endTime: string; untilDate: string; rows?: AttendeeRow[] }, clubId: string): Promise<{ seriesId: string; sessionIds: string[]; imported: number }>` — Zod-validates the title (1–200 chars); computes occurrences first (throws `RecurrenceError` before any write); inserts one `session_series` row; inserts all occurrences in ONE bulk insert (`title`, `starts_at`, `ends_at`, `series_id`, no eActivities binding), returning ids ordered by `starts_at`; if `rows` is non-empty calls `syncAttendanceCsv({ sessionId: sessionIds[0], rows }, clubId)` (first occurrence only) and returns `imported = result.added`; on any failure after the series row exists, deletes the sessions it created and the series row (best effort) before rethrowing.
  - `createRecurringSeriesAction(clubSlug: string, formData: FormData): Promise<{ success: boolean; message: string; firstSessionId?: string }>` (`"use server"`, `requireAdmin` first). Form fields: `title`, `firstDate` (YYYY-MM-DD), `startTime` (HH:mm), `endTime` (HH:mm), `untilDate`, optional `file`. If a file is given it must be `.csv`, parse with zero row errors and at least one row, **before** anything is created; messages mirror `createSessionFromCsv`. `RecurrenceError` → `{ success: false, message: error.message }`. Success message: `Created N weekly sessions.` plus ` Imported M attendee(s) into the first one.` when a CSV was given.

- [ ] **Step 1: Write failing tests** in `session-series-create.spec.ts` (call `createRecurringSeries` directly; for the action's validation use its pure helpers or the core function; the action itself needs an admin session): (a) 3-week series → 3 sessions with the same `series_id`, `club_id` of the caller, correct UTC instants (use a series crossing 25 Oct 2026), `ends_at` set, no eActivities ids; (b) with `rows` (2 attendees) → exactly the first occurrence has 2 `attendance_record`s with `source = 'csv_import'`, `attended = false`, the others have 0; (c) `endTime <= startTime` and `untilDate < firstDate` and a >60-week series throw `RecurrenceError` and create **no** `session_series` row for that title/club; (d) a roster whose emails collide in a way that makes `syncAttendanceCsv` throw (reuse the duplicate-email-in-file pattern from `csv-import.spec.ts`) leaves no sessions and no series row; (e) a second club's `listRecentSessions` does not see the first club's occurrences.
- [ ] **Step 2: Run** the spec — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** both files. Cleanup order in tests: `attendance_record`, `session`, `session_series`, `person`.
- [ ] **Step 4: Run** the spec, `npx tsc --noEmit`, eslint on changed files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sessions): create a weekly recurring series, signup CSV applies to the first occurrence`.

### Task 5: Recurring form, list link, quieter upcoming list

**Files:**
- Create: `app/club/[clubSlug]/sessions/recurring/page.tsx`, `app/club/[clubSlug]/sessions/recurring/loading.tsx`, `components/attendance/recurring-session-form.tsx`, `lib/session-series/upcoming.ts`
- Modify: `app/club/[clubSlug]/sessions/page.tsx`
- Test: `tests/unit/upcoming.spec.ts`

**Interfaces:**
- Consumes: `createRecurringSeriesAction` (Task 4), `SessionListItem.seriesId` (Task 3).
- Produces: `limitUpcomingPerSeries<T extends { id: string; seriesId: string | null }>(sessions: T[], perSeries: number): { shown: T[]; hiddenCountBySeries: Map<string, number> }` — keeps input order, keeps every non-series session, keeps at most `perSeries` of each series' sessions (the first ones in input order), and counts the rest. The sessions page applies it to the already-soonest-first Upcoming group with `perSeries = 3` and renders `+N more in this series` text under the last shown row of a trimmed series. A "New recurring series" button (`PendingLink`) is added next to the other create buttons. The page `app/club/[clubSlug]/sessions/recurring/page.tsx` follows the `sessions/import/page.tsx` structure (`requireAdmin` + redirect, back link, heading, `SignOutButton`); `loading.tsx` uses `PageSkeleton variant="form"`. The form is a client component with fields title, first date, start time, end time, repeat weekly until (date), optional CSV (`FilePickerButton`), sends dates/times **as typed** (no browser-timezone conversion: the server interprets them as Europe/London), shows pending state, toasts the message and routes to the first session on success. Helper text states "Times are Europe/London. The CSV applies to the first session only."

- [ ] **Step 1: Write failing unit tests** in `tests/unit/upcoming.spec.ts`: 6 sessions of one series + 2 non-series → with `perSeries` 3 shows 3 + 2 and `hiddenCountBySeries` has 3; order preserved; a series with 2 sessions is untouched; `perSeries` 0 is treated as hiding all series members but never non-series sessions.
- [ ] **Step 2: Run** `npx playwright test tests/unit/upcoming.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the helper, the page, loading skeleton, form, and the list changes. Read the Next.js docs for `loading.tsx`/server-action forms as AGENTS.md requires.
- [ ] **Step 4: Run** unit tests, `npx tsc --noEmit`, `npm run lint`, and `npm run build` — Expected: PASS (build proves the new route compiles; there is no signed-in e2e, so the page is checked by hand in Task 7).
- [ ] **Step 5: Commit** `feat(sessions): recurring series form, link, and a quieter upcoming list`.

### Task 6: Delete this and all later events

**Files:**
- Create: `lib/session-series/delete.ts`, `components/attendance/series-delete-panel.tsx`
- Modify: `lib/session-series/actions.ts`, `components/attendance/attendance-screen.tsx`
- Test: `tests/integration/session-series-delete.spec.ts`

**Interfaces:**
- Consumes: `session.series_id`, `SessionWithAttendance.seriesId` (Task 3).
- Produces:
  - `planSeriesDelete(sessionId: string, clubId: string): Promise<{ seriesId: string; toDelete: { id: string; startsAt: string }[]; kept: { id: string; title: string; startsAt: string; attendedCount: number }[] } | null>` — `null` when the session has no `series_id`. Loads the chosen session, then all sessions of that series in this club with `starts_at >=` the chosen `starts_at` (include the chosen one), then ONE query for `attendance_record` rows with `attended = true` and `session_id in (…)` (use `.in()` in chunks of ≤100 ids and `.range(0, 9999)` like `listRecentSessions`); sessions with ≥1 attended record go to `kept`, the rest to `toDelete`.
  - `executeSeriesDelete(sessionId: string, clubId: string): Promise<{ deleted: number; kept: number }>` — re-runs `planSeriesDelete` (never trusts a client-supplied list), deletes the unattended `attendance_record` rows of the `toDelete` sessions (filter `attended = false`), then the sessions in chunks of ≤100; finally deletes the `session_series` row only if no session still references it. Relies on `attendance_record.session_id` FK being `no action`: if an attended tick lands between plan and delete, the session delete fails and nothing is lost (report it as an error, do not retry).
  - Actions in `lib/session-series/actions.ts` (`"use server"`, `requireAdmin` + `assertSessionBelongsToClub` first): `previewSeriesDeleteAction(clubSlug, sessionId)` → the plan or `null`; `deleteSeriesFromAction(clubSlug, sessionId)` → `{ success, message }` with `Deleted N events.` plus ` Kept M with recorded attendance.` when M > 0.
  - UI: when `session.seriesId` is set, the attendance screen shows a "Delete this and all later events" button that opens an inline confirmation panel (no new dialog dependency) which calls the preview action, lists counts (`12 events will be deleted, 2 kept because they have attendance`) and the kept events' titles/dates, then a destructive confirm button; on success route to the sessions list.

- [ ] **Step 1: Write failing integration tests** in `session-series-delete.spec.ts` (call the core functions; build a 5-week series via `createRecurringSeries` or direct inserts): (a) plan from occurrence 3 targets occurrences 3–5 only; earlier ones are untouched after execute; (b) an attended record on occurrence 4 → occurrence 4 is `kept` with the right `attendedCount`, 3 and 5 deleted, the series row remains; (c) a *future* occurrence with an attended record is kept too; (d) an occurrence with only `attended = false` roster rows (CSV import) is deleted along with those rows; (e) deleting from occurrence 1 with nothing attended removes all sessions and the `session_series` row; (f) a non-series session → `planSeriesDelete` returns `null` and `executeSeriesDelete` deletes nothing; (g) cross-club: planning/executing with a session id from club B but `clubId` of club A returns null/refuses and club B's sessions remain; (h) >100 occurrences-worth of ids path is exercised by calling the chunking helper directly (unit-level on the chunk size) or by a 60-occurrence series (the maximum) deleted in one call.
- [ ] **Step 2: Run** the spec — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the core, actions and UI. Check `grep -rn "references public.session\|references session" supabase/migrations` to confirm `attendance_record` is the only FK into `session` and state the finding in the report.
- [ ] **Step 4: Run** the spec, the whole integration suite for `session`/`attendance` specs, `npx tsc --noEmit`, `npm run lint` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sessions): delete this and all later events of a series, keeping recorded attendance`.

### Task 7: Wrap-up

**Files:** Modify `docs/PROJECT_STATUS.md`.

- [ ] **Step 1: Run all suites:** `npm run test:unit`, `npm run test:integration`, `npm run lint`, `npm run build` — Expected: all pass except known pre-existing failures, which must be named (currently `person-search.spec.ts` "an email substring match ranks above a fuzzy name match" fails because the RPC orders ties arbitrarily; it predates this work).
- [ ] **Step 2: Record** in `docs/PROJECT_STATUS.md` a "Recurring events" section: what shipped, the Europe/London rule, the delete rule, and an explicit **NOT VERIFIED** line for the by-hand check of the recurring form, the end-time inputs and the delete panel in a signed-in browser (no signed-in e2e exists), plus the note that the migration must be applied to any other Supabase project before deploying.
- [ ] **Step 3: Commit** `docs: record recurring events and end time`.
