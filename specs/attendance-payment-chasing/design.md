# Attendance Tracking & Payment Chasing — Design

## Schema

```sql
-- Attendance Tracking & Payment Chasing — schema
-- Note: `attendance_record.waived_by_purchase_id` is added via a trailing
-- ALTER TABLE rather than inline, because `purchase` is defined after
-- `attendance_record` below and Postgres can't resolve a forward FK reference
-- inline within a single `create table` statement.

create table person (
  id uuid primary key default gen_random_uuid(),
  cid text unique,                          -- null until known (external/unconfirmed)
  shortcode text,                            -- e.g. 'ss5123' — optional, candidate CID key
  email text unique,                         -- always required for external walk-ins
  full_name text not null,
  is_student boolean,                        -- derived from Member Type at last known purchase/signup
  identity_confidence text not null default 'confirmed'
    check (identity_confidence in ('provisional','confirmed')),
  consent_to_reinvite text not null default 'not_asked'
    check (consent_to_reinvite in ('not_asked','opted_in','opted_out')),
  is_exempt boolean not null default false,
  exempt_set_by uuid references person(id),
  exempt_set_at timestamptz,
  archived_at timestamptz,                   -- year-end reset, zero-debt only
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table session (
  id uuid primary key default gen_random_uuid(),
  eactivities_event_id text unique,
  eactivities_signup_id text unique,         -- AC-8: admin-picked, not auto-detected
  title text not null,
  starts_at timestamptz not null,
  last_synced_at timestamptz,                -- drives AC-6 debounce, AC-7 window check
  created_at timestamptz not null default now()
);

create table attendance_record (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references person(id),
  session_id uuid not null references session(id),
  attended boolean not null default true,
  source text not null check (source in ('signup_sync','manual_tick','walk_in')),
  waived_by_purchase_id uuid,                -- FK added below, once `purchase` exists
  recorded_by uuid,                          -- admin who ticked it, if manual
  recorded_at timestamptz not null default now(),
  unique (person_id, session_id)              -- idempotency: one attendance row per person/session
);

create table product (
  id uuid primary key default gen_random_uuid(),
  name text not null,                        -- e.g. "Term 1 Pass", "Annual Membership", "Single Session"
  kind text not null check (kind in ('session_pass','term_pass','annual_pass','other')),
  covers_sessions int,                        -- null = unlimited (term/annual)
  covers_days int,                            -- resolved 2026-09-20: for term_pass/annual_pass, coverage window length in days from purchased_at. Null for session_pass/other.
  created_at timestamptz not null default now()
);

create table purchase (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references person(id),       -- null until matched (unmatched external row)
  product_id uuid references product(id),
  source text not null check (source in ('pluto_api','xlsx_upload')),
  source_row_id text,                         -- Pluto's unique sale id, or a hash of an XLSX row for idempotency
  raw_member_type text,                       -- verbatim value from Pluto/XLSX, kept for audit
  purchased_at timestamptz not null,
  match_status text not null default 'unmatched'
    check (match_status in ('cid_matched','email_matched','manual_matched','unmatched')),
  matched_by uuid,                            -- admin who confirmed a manual match, if applicable
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, source_row_id)               -- idempotency: same sale never ingested twice
);

alter table attendance_record
  add constraint attendance_record_waived_by_purchase_id_fkey
  foreign key (waived_by_purchase_id) references purchase(id);

create table sync_cursor (
  source text primary key check (source in ('eactivities','pluto')),
  last_synced_at timestamptz not null,
  last_synced_id text                          -- for sources with an increasing unique id
);

create table chase_email (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references person(id),
  debt_cycle_started_at timestamptz not null,
  sequence_number int not null,                -- 1 = first in cycle, requires approval
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','sent','cancelled')),
  approved_by uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
```

## Architecture Decisions

- **Debt is a derived query over an immutable ledger, not a stored counter.**
  Attendance and purchase rows are never mutated to reflect payment status; a
  purchase instead sets `waived_by_purchase_id` on the attendance rows it
  covers. This preserves a full audit trail (a requirement already implied by
  `core/PRD.md` / `core/WORKFLOWS.md`) and makes "resume counting after a pass
  expires" a natural consequence of a date-range query rather than a stateful
  flag that can drift out of sync with reality.

- **Idempotency is enforced via `UNIQUE(person_id, session_id)`** on
  `attendance_record` (and the analogous `UNIQUE(source, source_row_id)` on
  `purchase`). Both ticking attendance and re-ingesting a purchase become
  `INSERT ... ON CONFLICT DO NOTHING` operations — no separate application-level
  "have we seen this before?" check is required, and the guarantee holds even
  under concurrent writes, which a check-then-insert pattern would not.

- **Multi-admin real-time sync uses Supabase Realtime (Postgres logical
  replication) rather than locking.** Every open attendance screen subscribes
  to `attendance_record` changes scoped to the current `session_id`. There is
  no lock to acquire, hold, or release, and admins are expected to be actively
  working the same room concurrently (dividing names between them), which locks
  would only get in the way of. The failure mode of a dropped realtime
  connection is simply a missed live update, recoverable via the manual
  sync/refresh already required by AC-6.

- **Scheduling: Supabase `pg_cron` + Edge Functions for the per-session sync
  trigger, not Vercel Cron.** Vercel Hobby cron is capped at once/day, with
  timing only guaranteed within the scheduled hour — adequate for a daily
  Pluto poll or the weekly chase-email run, but not for AC-7 ("sync ~1 hour
  before each session's start time"), which is sub-daily and depends on each
  session's own `starts_at`. Driving that trigger from `pg_cron` + a Supabase
  Edge Function decouples it entirely from Vercel's plan limits — the daily
  Pluto poll and weekly chase run may still use Vercel Cron, but the
  session-specific sync must not.

- **eActivities auth failures and rate limits never trigger an automatic
  retry, anywhere.** A bad/missing `EACTIVITIES_API_KEY` returns 401; repeated
  auth failures ban the requesting IP for 1 hour, and excessive request
  volume (regardless of auth) bans it for 5 minutes — both IP-wide, so a
  naive retry loop risks taking the whole app offline, not just one sync.
  Instead: the manual "sync now" action is debounced (60s, tracked via
  `session.last_synced_at`) so it can't be spammed into a ban, and the
  scheduled sync's own cron interval provides backoff for free — a failed
  attempt just waits for the next tick rather than retrying in-process.

- **A term/annual pass purchase waives ALL of a person's currently-outstanding
  debt, not just debt within that pass's own forward coverage window.**
  MP-3's "covers prior unpaid attendance" is read broadly: buying the pass
  clears past dues entirely, matching the common real policy of "buy the
  membership, past dues forgiven." MP-1/MP-2's forward-looking "active pass"
  exclusion is handled separately and continuously by `outstanding_attendance`'s
  own date-window check — the waiver above is specifically the retroactive
  case. A `session_pass` purchase, by contrast, waives only up to its
  `covers_sessions` count of the person's *oldest* outstanding debt (FIFO) —
  it has a limited number of credits.
  **TRACKED GAP, not an oversight:** a session_pass currently provides no
  FORWARD coverage — sessions attended after purchase still become debt
  and are never automatically waived by that same purchase's remaining
  credits. A running session-credit-balance concept (how credits are
  consumed, whether unused credits expire) is needed before this ships for
  real session-pack sales, and is not yet designed.

- **A term/annual pass's coverage window is `[purchased_at, purchased_at +
  product.covers_days)`** — a half-open interval, per-product (not a shared
  academic-term calendar). `covers_days` is required (via a check
  constraint on `product`) whenever `kind` is `term_pass` or `annual_pass`,
  to prevent a half-curated product from silently waiving debt with no
  forward coverage.

- **A person's chronologically-earliest ATTENDED session
  (`attendance_record.attended = true`, ordered by `session.starts_at`) is
  their free trial and never counts as debt.** A no-show is not an
  attendance for this purpose, so it cannot consume the free trial — and
  separately, `attendance_record.attended = false` rows never count as
  debt at all, matching what the attendance-screen's attended/not-attended
  toggle is for.

- **Admin identity is an email string, not a `person.id` or generic `uuid`.**
  `chase_email.approved_by` and `person.exempt_set_by` were originally typed
  `uuid` from Phase 1, before admin auth existed. The actual admin-auth model
  built this session (`lib/auth/require-admin.ts`) identifies an admin by
  their Supabase Auth email checked against `admin_allowlist` — there is no
  "admin person" row anywhere in the schema. Both columns were corrected to
  `text` in `supabase/migrations/20260921100000_add_chase_email_content_and_fix_admin_identity_columns.sql`,
  before either was ever populated by real code.

- **A debt cycle is derived, not stored, the same way debt itself is (DC-1).**
  A person's active debt cycle is identified by the oldest `starts_at` among
  their currently-outstanding rows in `outstanding_attendance` (exposed via
  the `active_debt_cycle` view). This needs no separate cycle-tracking state
  and satisfies DC-6 for free: once every outstanding row for a person is
  waived, that person has zero rows in `outstanding_attendance` and
  disappears from `active_debt_cycle` entirely, so generation simply stops.
  If they later go into debt again, `min(starts_at)` naturally advances to
  the new oldest unpaid session, which is a new cycle by construction.

- **Chase-email cadence reuses the DC-2 threshold (N = 7 days) for repeats,
  and only fires the next reminder after the previous one was actually
  sent.** The first draft in a cycle fires N days after the cycle's oldest
  unpaid session. Each subsequent draft fires N days after the *previous*
  chase_email in that cycle reached `status = 'sent'` — not merely
  `approved` or `pending_approval`. This prevents drafts from piling up
  while an earlier one sits un-actioned, and avoids needing a second
  admin-configurable interval that nothing in the requirements asked for.

- **Repeat auto-send policy is a single boolean env var,
  `CHASE_AUTO_SEND_REPEATS`.** When unset/false (the default), every chase
  email — first or repeat — requires manual approval, same as DC-3 mandates
  for the first. When true, `sequence_number > 1` drafts are created
  pre-approved (`status = 'approved'`) and are picked up by the same
  scheduled job's auto-send pass. `sequence_number = 1` is never affected by
  this flag (DC-3 is unconditional).

- **Pre-send debt recheck (session addition, not in the original tasks.md
  text).** Immediately before `sendChaseEmail` marks a row `sent`, it
  re-fetches the person's live outstanding debt. If debt is already 0 (the
  person paid between drafting/approval and send), the row is marked
  `cancelled` with `note = 'Auto-cancelled: debt was already cleared before
  send.'` instead of `sent`, and no message goes out. Requested explicitly
  because a chase email can sit `pending_approval`/`approved` for days,
  during which the underlying debt (DC-1, always live) can change.

- **No real message dispatch.** `sendChaseEmail` only updates `chase_email`'s
  own `status`/`sent_at`/`note` — matching the project's existing approval-
  simulation model (`AGENTS.md`: "no real message sending unless explicitly
  built and approved"). `GMAIL_USER`/`GMAIL_APP_PASSWORD` already sit unused
  in `.env.local`; wiring them up is a distinct, not-yet-requested task.

- **No separate audit-log table for chase emails.** `chase_email`'s own
  `status`/`approved_by`/`approved_at`/`sent_at`/`note` columns already
  record who did what and when for every state transition — a dedicated
  `audit_log` table would just duplicate that, contradicting DC-1's
  derive-don't-duplicate philosophy applied to auditability instead of debt.

### a. Chase-email timing threshold — RESOLVED (2026-09-21)

N = 7 days. A draft chase email generates once a person's debt has been
continuously greater than zero for more than 7 days. The same 7-day period
is reused as the repeat-reminder cadence (see the "Chase-email cadence"
architecture decision below) rather than introducing a second configurable
interval nothing requested.

### b. First-chase approval policy — RESOLVED (2026-09-21)

The first chase email in a debt cycle always requires explicit admin
approval, with no auto-send exception. This is not a new decision so much
as a recognition that `requirements.md`'s DC-3 already states this
unconditionally ("SHALL require explicit admin approval before sending") —
the draft author's "approval-by-exception" idea for the first email was
never adopted into DC-3, and implementing it would have meant quietly
weakening a hard requirement. `sequence_number = 1` chase emails always
start at `status = 'pending_approval'`.

### c. Exemption authority & audit requirement — RESOLVED (2026-09-21)

Any admin can set or clear `person.is_exempt`. A reason
(`person.exempt_reason`) is optional, not mandatory. `exempt_set_by` records
the acting admin's email (from `admin_allowlist`, via `requireAdmin()`) and
`exempt_set_at` the timestamp; both are cleared (`null`) when exemption is
lifted, matching the "no longer applies" data model already used elsewhere
in this schema.

**RESOLVED (2026-09-20), free-trial sub-issue:** the debt query
(`outstanding_attendance`, see
`supabase/migrations/20260920120000_add_debt_calculation_functions.sql`)
auto-excludes each person's chronologically-earliest ATTENDED
`attendance_record` (by `session.starts_at`) from debt calculation — no
schema flag, no admin action needed.
