# Attendance Tracking & Payment Chasing — Implementation Tasks

Each task cites the `requirements.md` ID(s) it satisfies or enables. Ordered so
schema lands first, then adapters, then UI, then the derived/generated
behavior that depends on all of the above.

> **Scope note:** a few tasks below (identity/CID matching in Phase 4) implement
> behavior described in `source-draft.md`'s "Identity & Data Matching" section,
> which was intentionally left out of `requirements.md` in this pass (that file
> is scoped to exactly Attendance Capture / Membership & Purchases / Debt &
> Chasing). Those tasks are marked accordingly rather than cited against a
> requirement ID that doesn't exist yet.

## Phase 0 — Deployment Infrastructure

- [x] 0.1 Add a GitHub Actions keep-alive workflow that pings Supabase's REST
      endpoint on a schedule, so the project (Supabase free tier auto-pauses
      after 7 days idle) never goes to sleep between real usage — see
      `.github/workflows/supabase-keepalive.yml`. Requires GitHub repo secrets
      `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` (separate from the Vercel env
      vars below — GitHub Actions can't read Vercel's env store).
- [x] 0.2 Before first deploy, set these in Vercel → Settings → Environment
      Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
      `SUPABASE_SECRET_KEY` (server-only — never prefix with `NEXT_PUBLIC_`),
      `GMAIL_USER` / `GMAIL_APP_PASSWORD` (or `RESEND_API_KEY` later), and
      `CRON_SECRET` (random string used to verify scheduled job requests
      hitting any cron-triggered route).
- [x] 0.3 First deploy to Vercel — gives a free `*.vercel.app` URL, usable on
      any phone browser with no app-store step; committee members can "Add to
      Home Screen" for an app-like icon.
  - Note: Vercel Hobby cron is capped at once/day with timing only guaranteed
    within the scheduled hour — fine for a daily Pluto poll or the weekly
    chase-email run, but not for AC-7's "sync ~1 hour before each session's
    start time" (sub-daily, session-specific). See the "Scheduling" decision
    in `design.md` — that trigger uses Supabase `pg_cron` + Edge Functions
    instead, decoupled from Vercel's plan limits.

## Phase 1 — Schema & Migrations

- [x] 1.1 Migration: `person` table (id, cid, shortcode, email, full_name,
      is_student, identity_confidence, consent_to_reinvite, is_exempt,
      exempt_set_by/at, archived_at, timestamps) — **Enables:** AC-4, AC-5, MP-5, DC-5
- [x] 1.2 Migration: `session` table — **Enables:** AC-1, AC-6, AC-7
- [x] 1.3 Migration: `product` table — **Enables:** MP-1, MP-2, MP-3
- [x] 1.4 Migration: `purchase` table incl. `UNIQUE(source, source_row_id)` — **Enables:** MP-4, MP-5, MP-6
- [x] 1.5 Migration: `attendance_record` table incl. `UNIQUE(person_id, session_id)`,
      with `waived_by_purchase_id`'s FK added as a trailing `ALTER TABLE` after
      `purchase` exists — **Enables:** AC-2, MP-1, MP-3
- [x] 1.6 Migration: `sync_cursor` table — **Enables:** AC-6, AC-7
- [x] 1.7 Migration: `chase_email` table — **Enables:** DC-2, DC-3, DC-4, DC-6
  - [x] Verify: all migrations apply cleanly in order on an empty database (no
        forward-reference errors)

## Phase 2 — eActivities Sign-up Sync Adapter

- [x] 2.1 Implement `EactivitiesProvider.getSignup` (`GET
      /csp/{centre}/signups/{id}` — requires `session.eactivities_signup_id`,
      see AC-8/task 3.0) and sync: fetch that signup's `Attendees` roster and
      upsert `person` (CID-priority match, else email, else create) /
      `attendance_record (source='signup_sync')` rows via `INSERT ... ON
      CONFLICT (person_id, session_id) DO NOTHING` — **Satisfies:** AC-1
- [x] 2.2 Implement the manual sync/refresh trigger, merging new sign-ups
      without duplicating or losing existing ticks; debounce against
      `session.last_synced_at` (60s) so it can't be spammed into eActivities'
      rate-limit ban; gated by `SYNC_TRIGGER_SECRET` (flagged by security
      review — without it, the route is reachable directly with no UI,
      letting a caller enumerate `sessionId`s to bypass the per-session
      debounce entirely) until real admin auth exists — **Satisfies:** AC-6
  - [ ] Verify: re-running sync against an unchanged sign-up list produces zero
        new/changed attendance rows
  - [ ] Verify: a second sync attempt inside the debounce window is rejected
        without calling eActivities
  - [ ] Verify: a request without a valid `SYNC_TRIGGER_SECRET` gets 401 and
        never reaches `syncSessionAttendance`
- [x] 2.3 Implement the scheduled trigger that syncs each session
      automatically ~1 hour before its `starts_at`, via Supabase `pg_cron` +
      an Edge Function dispatcher calling a `CRON_SECRET`-protected route
      (not Vercel Cron — see `design.md`'s Scheduling decision) — **Satisfies:** AC-7
- [x] 2.4 Update `sync_cursor` for the `eactivities` source after each
      successful sync (observability only — the actual per-session
      debounce/window logic uses `session.last_synced_at`, not this table;
      see `design.md`'s Architecture Decisions)
- [x] 2.5 No automatic retries on eActivities 401/403 responses anywhere in
      this adapter — both are IP-wide bans (1hr / 5min). A failed call
      throws; callers do not retry it themselves.

## Phase 3 — Attendance-Ticking UI with Realtime Sync

- [x] 3.0 Build the session-creation admin screen: pick a What's On event
      (`EactivitiesProvider.getEvents`), then pick which of that event's
      attached signups represents attendance (`getEvent(eventId)` →
      `Signups[]` — no automatic way to tell; see AC-8), saving
      `session.eactivities_event_id` + `eactivities_signup_id` + `title` +
      `starts_at`. Not built in the Phase 2 pass — flagged there as a
      precondition for 2.1 that didn't exist yet. Until this exists, test
      sessions get `eactivities_signup_id` set directly via SQL. —
      **Satisfies:** AC-8

- [x] 3.1 Build the attendance screen: list sign-ups for a session, each row
      togglable attended/not-attended — **Satisfies:** AC-1
- [x] 3.2 Wire the toggle to an idempotent upsert (`INSERT ... ON CONFLICT DO
      NOTHING`) against `UNIQUE(person_id, session_id)` — **Satisfies:** AC-2
  - [ ] Verify: double-ticking the same person for the same session produces
        exactly one `attendance_record` row
  - [ ] Verify: unticking removes exactly the row for that person/session pair
- [x] 3.3 Subscribe the attendance screen to Supabase Realtime changes on
      `attendance_record` scoped to the current `session_id`; reflect remote
      toggles within 2 seconds — **Satisfies:** AC-3
- [x] 3.3a **TRACKED GAP, not an oversight:** `attendance_record`'s RLS policy
      (`attendance_record_select_anon`, added in the 1.5 migration) currently
      grants `SELECT` to the `anon` role — required for Supabase Realtime's
      `postgres_changes` to deliver events to the browser at all, since no
      admin-auth system exists yet (`person`/`purchase`/etc. stay deny-all;
      `attendance_record` was deliberately split for this reason). Once a
      real auth system exists, replace `attendance_record_select_anon` with a
      policy scoped to an authenticated admin role, and confirm Realtime
      subscriptions still work under it before removing the anon policy.
- [x] 3.4 Implement fuzzy name search against existing `person` records when a
      searched name isn't in the current sign-up list — **Satisfies:** AC-4
- [x] 3.5 Implement the walk-in creation form (email required, shortcode
      optional); records created this way get `identity_confidence =
      'provisional'` — **Satisfies:** AC-5

## Phase 4 — Pluto/XLSX Purchase-Ingestion Adapter

- [x] 4.1 Define the shared internal purchase-ingestion interface used by both
      the Pluto API poller and the XLSX upload path — **Satisfies:** MP-4
- [ ] 4.2 **TRACKED GAP, not an oversight:** Pluto has no real API contract
      yet (`core/INTEGRATIONS.md`'s "Pluto adapter" section — "being rolled
      out progressively... should be treated as a future provider"). Rather
      than ship a fictional integration against invented endpoints, `lib/pluto/client.ts`
      is a stub whose `getSales()` throws a descriptive not-implemented
      error; no poller, no cron wiring. XLSX (4.3) is the only real
      ingestion path for now. Revisit once Pluto publishes real docs. See
      `docs/superpowers/plans/2026-09-19-purchase-ingestion.md` Task 3.
- [x] 4.3 Implement the XLSX upload adapter, writing `purchase` rows with
      `source='xlsx_upload'` — **Satisfies:** MP-4
- [x] 4.4 Derive and store `is_student` per purchase row from the raw `Member
      Type` value (`true` only on an exact, case-insensitive `Student` match,
      `false` otherwise — see `isStudentMemberType()` in `lib/purchase/types.ts`);
      retain `raw_member_type` for audit — **Satisfies:** MP-5
- [x] 4.5 Enforce idempotent ingestion via `UNIQUE(source, source_row_id)`
      (hash XLSX rows to derive a stable `source_row_id`) — **Satisfies:** MP-6
  - [x] Verify: re-uploading the same XLSX file, or re-polling Pluto past an
        already-seen sale, creates zero additional `purchase` rows
        (verified for XLSX; Pluto path not applicable per 4.2)
- [ ] 4.6 *(Identity matching — not yet a `requirements.md` item, see scope
      note above)* Implement CID-priority matching for `is_student = true`
      purchase rows, and email-match-or-manual-review routing for `is_student =
      false` rows, per `source-draft.md`'s Identity & Data Matching section.
      **Partially done:** `lib/purchase/matcher.ts` implements both routing
      rules against XLSX data now (CID-priority for students, no email
      fallback; email match for everyone else). Left open because the first
      verify item below needs Pluto (4.2), which doesn't exist yet.
  - [ ] Verify: an eActivities signup and a later Pluto purchase with the same
        CID but a differently-spelled name resolve to one person record
        (blocked on 4.2)
  - [x] Verify: an `is_student = false` row with no email match and no name
        match ends up in the manual-review queue with `match_status =
        'unmatched'`, not linked to any person. Unmatched rows now also
        retain `raw_person_name`/`raw_email`/`raw_cid` so the future
        manual-review queue has something to show (added in the final
        review's fix round — see the plan's ledger).

## Phase 5 — Debt Calculation

- [x] 5.1 Implement the debt query: unpaid sessions = attendance records with
      no covering purchase/waiver, excluding sessions covered by an active
      term/annual pass at the time attended — **Satisfies:** MP-1, DC-1
- [x] 5.2 Implement pass-expiry handling so attendance after a term/annual
      pass's coverage window resumes counting toward debt — **Satisfies:** MP-2
  - [x] Verify: attendance during a pass's coverage window doesn't count;
        attendance after expiry does
- [x] 5.3 Implement waiver logic: when a covering pass/membership is
      purchased, set `waived_by_purchase_id` on the historical attendance rows
      it covers, without deleting them — **Satisfies:** MP-3
  - [x] Verify: a person with unpaid attendance records who buys a covering
        term pass has debt drop to 0, every one of those rows gets a
        non-null `waived_by_purchase_id`, and none of them are deleted
        (exercised with 2 unpaid records in the term-pass test and 3 in
        the session-pass test — the term/annual branch waives ALL
        outstanding debt regardless of count, so the mechanism is
        count-agnostic)

## Phase 6 — Chase Email Generator

- [x] 6.1 Scheduled job: for each person with debt continuously > 0 for more
      than N days (config value: 7 days, see design.md's Open Question (a) resolution; env var CHASE_THRESHOLD_DAYS),
      generate a draft `chase_email` row — **Satisfies:** DC-2
- [x] 6.2 Assign `sequence_number` per debt cycle; `sequence_number = 1` starts
      at `status = 'pending_approval'` — **Satisfies:** DC-3
- [x] 6.3 Implement the configurable auto-send policy for repeat reminders
      (`sequence_number > 1`), logging every send to the audit trail — **Satisfies:** DC-4
      (policy: env var CHASE_AUTO_SEND_REPEATS, see design.md)
- [x] 6.4 Exclude exempt persons (`is_exempt = true`) from chase-email
      generation — **Satisfies:** DC-5 (any admin, reason optional, see design.md)
- [x] 6.5 Stop generating further chase emails for a debt cycle once debt
      reaches zero — **Satisfies:** DC-6
  - [x] Verify: a person with `is_exempt = true` and debt > 0 never gets a
        `chase_email` row
  - [x] Verify: `sequence_number = 1` always starts `pending_approval`;
        `sequence_number > 1` may start `approved` only when the auto-send
        policy is active for that cycle

## Phase 7 — Approval Inbox

- [x] 7.1 Build the approval inbox listing `chase_email` rows with `status =
      'pending_approval'` — **Satisfies:** DC-3 (lists `pending_approval` +
      `approved`-but-unsent, a documented superset so the same page can
      also trigger sends)
- [x] 7.2 Implement the approve action: set `status = 'approved'`,
      `approved_by`, `approved_at` — **Satisfies:** DC-3
- [x] 7.3 Implement the send action (manual, or triggered by the auto-send
      policy): set `status = 'sent'`, `sent_at`, and write an audit log entry — **Satisfies:** DC-4
- [x] 7.4 Implement the reject/cancel action: set `status = 'cancelled'` and
      preserve reviewer feedback, per `core/RULES.md` §10 ("every rejected
      draft should preserve reviewer feedback") — note is attributed
      (`<actor email> @ <ISO timestamp>: <feedback>`) rather than raw text
