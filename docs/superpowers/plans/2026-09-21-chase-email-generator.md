# Chase Email Generator (Phase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `tasks.md` Phase 6 — generate draft chase emails for persons with continuous outstanding debt past a threshold, gate sequence-1 emails behind admin approval, allow a configurable auto-send policy for repeats, exclude exempt persons, and stop generating once debt clears.

**Architecture:** A new `public.active_debt_cycle` view derives each non-exempt person's current debt count and the start of their active debt cycle (the oldest currently-outstanding session) from the existing `outstanding_attendance` view — no new stored "cycle" state. A weekly Vercel Cron route calls `generateChaseEmails()` (drafts new `chase_email` rows once a cycle has aged past the threshold) then `processAutoSends()` (sends any repeat reminder that was auto-approved, after re-checking the person's debt is still non-zero). Exemption is a plain admin-gated server action. No real email is dispatched — "sending" is simulated (status + timestamp + note), matching this project's existing approval-simulation model.

**Tech Stack:** Next.js Server Actions/Route Handlers, Supabase Postgres (view, no new functions needed), Playwright (unit + integration tests), `createAdminClient()` (service_role).

**Spec:** `specs/attendance-payment-chasing/design.md` + `requirements.md` (DC-2, DC-3, DC-4, DC-5, DC-6). Implements `tasks.md` Phase 6 (6.1–6.5).

## Global Constraints

- **DC-1 (carried forward).** Debt is always derived live, never stored as a mutable counter.
- **DC-2.** A draft chase email generates once a person's debt has been continuously > 0 for more than N days. **This session's decision: N = 7.**
- **DC-3.** The first chase email in a debt cycle (`sequence_number = 1`) ALWAYS starts at `status = 'pending_approval'`. No auto-send exception exists for the first email — this is a plain reading of the requirement's unconditional SHALL, not a placeholder pending further decision (Open Question (b) is resolved this way, see design.md).
- **DC-4.** A repeat reminder (`sequence_number > 1`) MAY auto-send under an admin-configured policy, and every send is logged. **This session's decision:** the policy is a single boolean env var `CHASE_AUTO_SEND_REPEATS` (default off/unset = manual approval required for every email, same as the first).
- **DC-5.** Exempt persons (`person.is_exempt = true`) never get chase emails. **This session's decision:** any admin can set or clear `is_exempt`; a reason is optional (`person.exempt_reason`, nullable).
- **DC-6.** Once a person's debt reaches zero, chase-email generation for that cycle stops immediately. Achieved for free by deriving cycles from `outstanding_attendance`: a person with zero debt simply has no row in `active_debt_cycle`.
- **New requirement from this session (not in the original tasks.md text, added by explicit user request):** immediately before any send (manual approve-and-send in a future Phase 7, or this phase's auto-send path), re-check the person's live outstanding debt. If it is now 0, do not send — mark the row `cancelled` with an explanatory `note` instead.
- **No real message dispatch.** Per `AGENTS.md`'s "no real message sending unless explicitly built and approved," `sendChaseEmail` only flips `status`/`sent_at`/`note` on the `chase_email` row — it never calls an email provider. `GMAIL_USER`/`GMAIL_APP_PASSWORD` already exist in `.env.local` but are intentionally left unwired.
- **No new admin UI.** Same pattern as Phase 5: this phase is backend logic only. The approval inbox is Phase 7.
- **Admin identity is an email string**, not a `person.id` or generic `uuid`. `requireAdmin()` (`lib/auth/require-admin.ts`) returns `{ email: string }` checked against `admin_allowlist` — there is no "admin person" row. `chase_email.approved_by` and `person.exempt_set_by` were originally typed `uuid` (a Phase-1 schema mistake, never previously exercised by any code); Task 1 corrects both to `text`.

---

### Task 1: Schema fixes + design.md decisions

**Files:**
- Create: `supabase/migrations/20260921100000_add_chase_email_content_and_fix_admin_identity_columns.sql`
- Modify: `specs/attendance-payment-chasing/design.md`

**Interfaces:**
- Produces: `chase_email.subject text`, `chase_email.body text`, `chase_email.note text` (all nullable at the DB level; required by application code before insert/update); `chase_email.approved_by` now `text`; `person.exempt_set_by` now `text`; `person.exempt_reason text` (nullable).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Confirm both affected columns are still empty before changing their type**

Run via `mcp__supabase__execute_sql`:
```sql
select
  (select count(*) from chase_email where approved_by is not null) as chase_approved_by_rows,
  (select count(*) from person where exempt_set_by is not null) as person_exempt_set_by_rows;
```
Expected: both `0` (Phase 6/7 features that populate these columns don't exist yet). If either is non-zero, stop and report — the migration below assumes no live data depends on the old `uuid` semantics.

- [ ] **Step 2: Write the migration**

```sql
-- Migration: chase-email content columns; fix admin-identity column types
-- specs/attendance-payment-chasing/tasks.md Phase 6
-- Enables: DC-2, DC-3, DC-5

-- chase_email had no columns to hold the actual drafted email content.
alter table public.chase_email add column subject text;
alter table public.chase_email add column body text;
-- Freeform note: why a row ended up cancelled (this phase's pre-send debt
-- recheck) or, later, why a Phase 7 reviewer rejected it. Same kind of
-- "why this row is in its terminal state" fact either way -- one column.
alter table public.chase_email add column note text;

comment on column public.chase_email.subject is 'Drafted email subject. Set at creation, never regenerated.';
comment on column public.chase_email.body is 'Drafted email body. Set at creation, never regenerated.';
comment on column public.chase_email.note is 'Freeform explanation for a cancelled/rejected row (auto-cancel reason or reviewer feedback).';

-- approved_by was `uuid` with nothing to reference -- admin identity in this
-- app is a Supabase Auth email checked against admin_allowlist (see
-- lib/auth/require-admin.ts), never a person.id or any other uuid. Store the
-- admin's email directly. (Confirmed empty in Step 1 -- USING cast is safe
-- but moot.)
alter table public.chase_email alter column approved_by type text using approved_by::text;

-- Same mistake on person.exempt_set_by: it referenced person(id), but the
-- actor setting an exemption is always an admin (email), never a person
-- record.
alter table public.person drop constraint if exists person_exempt_set_by_fkey;
alter table public.person alter column exempt_set_by type text using exempt_set_by::text;
alter table public.person add column exempt_reason text;

comment on column public.person.exempt_set_by is 'Admin email who set/cleared is_exempt (from admin_allowlist, not a person.id).';
comment on column public.person.exempt_reason is 'Optional freeform reason for the exemption. May be null.';
```

Apply it via `mcp__supabase__apply_migration` (name: `add_chase_email_content_and_fix_admin_identity_columns`).

- [ ] **Step 3: Verify live**

```sql
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'chase_email'
  and column_name in ('subject', 'body', 'note', 'approved_by');

select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'person'
  and column_name in ('exempt_set_by', 'exempt_reason');

select conname from pg_constraint where conname = 'person_exempt_set_by_fkey';
```
Expected: `approved_by` and `exempt_set_by` are `text`; `subject`/`body`/`note`/`exempt_reason` exist as `text`; the FK constraint query returns zero rows (dropped).

- [ ] **Step 4: Update `design.md`**

Find the `### a. Chase-email timing threshold` section (through the end of `### c. Exemption authority & audit requirement`, including its existing `**RESOLVED (2026-09-20):**` paragraph) and replace the entire block (from `### a. Chase-email timing threshold` through the end of the existing RESOLVED paragraph) with:

```markdown
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
```

Then, in the `## Architecture Decisions` section, append these new bullets at the end:

```markdown
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
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260921100000_add_chase_email_content_and_fix_admin_identity_columns.sql specs/attendance-payment-chasing/design.md
git commit -m "$(cat <<'EOF'
db+docs: fix chase_email/person admin-identity columns, resolve Phase 6 open questions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C3ppv3hK8tNQmnRQkF4XdK
EOF
)"
```

---

### Task 2: `active_debt_cycle` view, TS wrapper, email content template

**Files:**
- Create: `supabase/migrations/20260921110000_add_active_debt_cycle_view.sql`
- Create: `lib/chase/debt-cycles.ts`
- Create: `lib/chase/template.ts`
- Test: `tests/unit/chase-template.spec.ts`

**Interfaces:**
- Consumes: `public.outstanding_attendance` (Task 5.1, already live), `person.is_exempt` (Phase 1).
- Produces: `listActiveDebtCycles(): Promise<ActiveDebtCycle[]>` where `ActiveDebtCycle = { personId: string; fullName: string; email: string; debtCycleStartedAt: string; debtCount: number }` — consumed by Task 3. `buildChaseEmailContent(input: { fullName: string; debtCount: number }): { subject: string; body: string }` — consumed by Task 3.

- [ ] **Step 1: Write the view migration**

```sql
-- Migration: active_debt_cycle view
-- specs/attendance-payment-chasing/tasks.md 6.1, 6.4
-- Enables: DC-2, DC-5

-- One row per non-exempt person who currently has outstanding debt, giving
-- the start of their active debt cycle (oldest currently-outstanding
-- session) and their current debt count. Exempt persons (DC-5) never appear
-- here, so chase-email generation naturally never considers them. A person
-- with zero debt also never appears here (DC-1/DC-6): this view IS the
-- "does this person have an active debt cycle" answer.
create or replace view public.active_debt_cycle as
select
  p.id as person_id,
  p.full_name,
  p.email,
  min(oa.starts_at) as debt_cycle_started_at,
  count(*) as debt_count
from public.outstanding_attendance oa
join public.person p on p.id = oa.person_id
where not p.is_exempt
group by p.id, p.full_name, p.email;

comment on view public.active_debt_cycle is
  'DC-2/DC-5/DC-6: one row per non-exempt person with current outstanding debt, with their debt cycle''s start date and count. See specs/attendance-payment-chasing/design.md.';
```

Apply via `mcp__supabase__apply_migration` (name: `add_active_debt_cycle_view`).

- [ ] **Step 2: Verify live**

```sql
select pg_get_viewdef('public.active_debt_cycle'::regclass, true);
select * from public.active_debt_cycle limit 5;
```
Expected: view definition matches the SQL above; the select runs without error (rows depend on current data, may be empty — that's fine).

- [ ] **Step 3: Write `lib/chase/debt-cycles.ts`**

```typescript
import { createAdminClient } from "@/lib/supabase/admin";

export type ActiveDebtCycle = {
  personId: string;
  fullName: string;
  email: string;
  debtCycleStartedAt: string;
  debtCount: number;
};

// DC-2/DC-5/DC-6: every non-exempt person currently in debt, derived live
// from public.active_debt_cycle -- see
// supabase/migrations/20260921110000_add_active_debt_cycle_view.sql.
export async function listActiveDebtCycles(): Promise<ActiveDebtCycle[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("active_debt_cycle")
    .select("person_id, full_name, email, debt_cycle_started_at, debt_count");

  if (error) {
    throw new Error(`Failed to list active debt cycles: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    personId: row.person_id,
    fullName: row.full_name,
    email: row.email,
    debtCycleStartedAt: row.debt_cycle_started_at,
    debtCount: Number(row.debt_count),
  }));
}
```

- [ ] **Step 4: Write `lib/chase/template.ts`**

```typescript
// Deterministic chase-email content -- no LLM involved. Kept as a pure
// function (no I/O) so it's unit-testable without a live database.
export function buildChaseEmailContent(input: {
  fullName: string;
  debtCount: number;
}): { subject: string; body: string } {
  const { fullName, debtCount } = input;
  const sessionWord = debtCount === 1 ? "session" : "sessions";

  const subject = `Payment reminder: ${debtCount} unpaid ${sessionWord}`;

  const body = [
    `Hi ${fullName},`,
    "",
    `Our records show you have ${debtCount} unpaid ${sessionWord} outstanding.`,
    "Please arrange payment at your earliest convenience, or get in touch if you think this is a mistake.",
    "",
    "Thanks,",
    "The committee",
  ].join("\n");

  return { subject, body };
}
```

- [ ] **Step 5: Write the unit test**

```typescript
import { test, expect } from "@playwright/test";
import { buildChaseEmailContent } from "@/lib/chase/template";

test.describe("buildChaseEmailContent", () => {
  test("singular wording for exactly 1 unpaid session", () => {
    const { subject, body } = buildChaseEmailContent({ fullName: "Ada Lovelace", debtCount: 1 });
    expect(subject).toBe("Payment reminder: 1 unpaid session");
    expect(body).toContain("Hi Ada Lovelace,");
    expect(body).toContain("1 unpaid session outstanding");
    expect(body).not.toContain("sessions outstanding");
  });

  test("plural wording for more than 1 unpaid session", () => {
    const { subject, body } = buildChaseEmailContent({ fullName: "Grace Hopper", debtCount: 3 });
    expect(subject).toBe("Payment reminder: 3 unpaid sessions");
    expect(body).toContain("3 unpaid sessions outstanding");
  });

  test("does not throw or produce empty content for 0 (defensive -- callers should never pass 0)", () => {
    const { subject, body } = buildChaseEmailContent({ fullName: "Zero Debt", debtCount: 0 });
    expect(subject.length).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run the unit test**

Run: `npm run test:unit`
Expected: all pass, including the 3 new tests above alongside the 10 pre-existing ones (13 total).

- [ ] **Step 7: `tsc`/`lint`**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean (the one pre-existing `lib/pluto/client.ts` lint warning is unrelated and may still appear).

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260921110000_add_active_debt_cycle_view.sql lib/chase/debt-cycles.ts lib/chase/template.ts tests/unit/chase-template.spec.ts
git commit -m "$(cat <<'EOF'
feat(chase): add active_debt_cycle view, debt-cycles wrapper, email template

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C3ppv3hK8tNQmnRQkF4XdK
EOF
)"
```

---

### Task 3: `generateChaseEmails()` — draft creation with cadence + sequencing

**Files:**
- Create: `lib/chase/generator.ts`
- Test: `tests/integration/chase-generator.spec.ts`

**Interfaces:**
- Consumes: `listActiveDebtCycles()` (Task 2), `buildChaseEmailContent()` (Task 2), `chase_email` table (via `createAdminClient()`).
- Produces: `generateChaseEmails(): Promise<{ created: number }>` — consumed by Task 5's cron route.

- [ ] **Step 1: Write `lib/chase/generator.ts`**

```typescript
import { createAdminClient } from "@/lib/supabase/admin";
import { listActiveDebtCycles } from "@/lib/chase/debt-cycles";
import { buildChaseEmailContent } from "@/lib/chase/template";

const CHASE_THRESHOLD_DAYS = Number(process.env.CHASE_THRESHOLD_DAYS ?? 7);
const AUTO_SEND_REPEATS = process.env.CHASE_AUTO_SEND_REPEATS === "true";

function daysBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24);
}

// DC-2/DC-3/DC-4/DC-6: draft the next chase_email for every active debt
// cycle whose cadence has come due. See design.md's "Chase-email cadence"
// and "Repeat auto-send policy" architecture decisions.
export async function generateChaseEmails(): Promise<{ created: number }> {
  const admin = createAdminClient();
  const cycles = await listActiveDebtCycles();
  const now = new Date();
  let created = 0;

  for (const cycle of cycles) {
    const { data: existing, error: existingError } = await admin
      .from("chase_email")
      .select("sequence_number, status, sent_at")
      .eq("person_id", cycle.personId)
      .eq("debt_cycle_started_at", cycle.debtCycleStartedAt)
      .order("sequence_number", { ascending: false })
      .limit(1);

    if (existingError) {
      throw new Error(
        `Failed to look up existing chase emails for person ${cycle.personId}: ${existingError.message}`
      );
    }

    const last = existing?.[0];
    let shouldGenerate = false;
    let nextSequence = 1;

    if (!last) {
      shouldGenerate =
        daysBetween(new Date(cycle.debtCycleStartedAt), now) >= CHASE_THRESHOLD_DAYS;
    } else if (last.status === "sent" && last.sent_at) {
      nextSequence = last.sequence_number + 1;
      shouldGenerate = daysBetween(new Date(last.sent_at), now) >= CHASE_THRESHOLD_DAYS;
    }
    // else: a draft/pending_approval/approved row already exists for this
    // cycle and hasn't been sent yet -- don't pile up another one on top of
    // it. This is the mechanism, not a special case: shouldGenerate simply
    // stays false.

    if (!shouldGenerate) continue;

    const { subject, body } = buildChaseEmailContent({
      fullName: cycle.fullName,
      debtCount: cycle.debtCount,
    });
    const status =
      nextSequence === 1 ? "pending_approval" : AUTO_SEND_REPEATS ? "approved" : "pending_approval";

    const { error: insertError } = await admin.from("chase_email").insert({
      person_id: cycle.personId,
      debt_cycle_started_at: cycle.debtCycleStartedAt,
      sequence_number: nextSequence,
      status,
      subject,
      body,
    });

    if (insertError) {
      throw new Error(
        `Failed to create chase_email for person ${cycle.personId}: ${insertError.message}`
      );
    }

    created++;
  }

  return { created };
}
```

- [ ] **Step 2: Write the integration test**

Follow the existing helper/cleanup pattern from `tests/integration/debt-calculation.spec.ts` and `tests/integration/purchase-waivers.spec.ts` (a `createPerson`/`createAttendance` helper, `test.afterEach` deleting in FK-safe order: `chase_email`/`attendance_record` → `person`, every delete checked and thrown on error).

```typescript
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateChaseEmails } from "@/lib/chase/generator";

const admin = createAdminClient();

async function createPerson(overrides: { isExempt?: boolean } = {}) {
  const email = `chase-gen-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({
      full_name: "Chase Gen Test Person",
      email,
      is_exempt: overrides.isExempt ?? false,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createAttendance(personId: string, startsAt: Date) {
  const { data: session, error: sessionError } = await admin
    .from("session")
    .insert({ title: "Chase Gen Test Session", starts_at: startsAt.toISOString() })
    .select("id")
    .single();
  if (sessionError) throw sessionError;

  const { error: attendanceError } = await admin
    .from("attendance_record")
    .insert({ person_id: personId, session_id: session.id, source: "manual_tick" });
  if (attendanceError) throw attendanceError;

  return session.id as string;
}

test.describe("generateChaseEmails", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: attendanceError } = await admin
      .from("attendance_record")
      .delete()
      .eq("person_id", personId);
    if (attendanceError) throw attendanceError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("a person with 2 unpaid sessions, the older past the 7-day threshold, gets a sequence-1 draft", async () => {
    personId = await createPerson();
    const now = new Date();
    // Free trial (excluded from debt) -- push it further back so it's
    // unambiguously the earliest attendance ever.
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    // This is the oldest DEBT-counting session -- 10 days ago, past the
    // 7-day default threshold.
    await createAttendance(personId, new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));

    const result = await generateChaseEmails();
    expect(result.created).toBeGreaterThanOrEqual(1);

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("sequence_number, status, subject, body")
      .eq("person_id", personId);
    if (error) throw error;

    expect(rows).toHaveLength(1);
    expect(rows![0].sequence_number).toBe(1);
    expect(rows![0].status).toBe("pending_approval");
    expect(rows![0].subject).toContain("1 unpaid session");
  });

  test("running generateChaseEmails twice in a row does not create a duplicate draft", async () => {
    personId = await createPerson();
    const now = new Date();
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));

    await generateChaseEmails();
    await generateChaseEmails();

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("id")
      .eq("person_id", personId);
    if (error) throw error;
    expect(rows).toHaveLength(1);
  });

  test("a person with debt younger than the threshold gets no draft", async () => {
    personId = await createPerson();
    const now = new Date();
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    // Only 2 days old -- under the 7-day threshold.
    await createAttendance(personId, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));

    await generateChaseEmails();

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("id")
      .eq("person_id", personId);
    if (error) throw error;
    expect(rows).toHaveLength(0);
  });

  test("an exempt person with old debt gets no draft (DC-5)", async () => {
    personId = await createPerson({ isExempt: true });
    const now = new Date();
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));

    await generateChaseEmails();

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("id")
      .eq("person_id", personId);
    if (error) throw error;
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the integration test**

Run: `npm run test:integration`
Expected: all pass, including these 4 new tests alongside the 9 pre-existing ones (13 total). Note: this test file runs against real time via `Date.now()`; if it ever becomes flaky near a day boundary, that's an acceptable trade-off already made by every other integration test in this repo that uses relative dates (see `debt-calculation.spec.ts`).

- [ ] **Step 4: `tsc`/`lint`/`build`**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add lib/chase/generator.ts tests/integration/chase-generator.spec.ts
git commit -m "$(cat <<'EOF'
feat(chase): implement generateChaseEmails (DC-2, DC-3, DC-4, DC-6)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C3ppv3hK8tNQmnRQkF4XdK
EOF
)"
```

---

### Task 4: `sendChaseEmail()` / `processAutoSends()` — pre-send debt recheck + auto-send

**Files:**
- Create: `lib/chase/send.ts`
- Test: `tests/integration/chase-send.spec.ts`

**Interfaces:**
- Consumes: `getOutstandingDebt(personId)` (`lib/debt/calculator.ts`, Phase 5, already live), `chase_email` table.
- Produces: `sendChaseEmail(chaseEmailId: string): Promise<{ sent: boolean; reason?: string }>` and `processAutoSends(): Promise<{ sent: number; cancelled: number }>` — consumed by Task 5's cron route.

- [ ] **Step 1: Write `lib/chase/send.ts`**

```typescript
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";

// Session addition (not in the original tasks.md text, requested directly
// this session): re-check live debt immediately before sending. A chase
// email can sit approved for days; if the person paid in the meantime, this
// cancels the send instead of chasing a cleared debt. See design.md's
// "Pre-send debt recheck" architecture decision.
export async function sendChaseEmail(
  chaseEmailId: string
): Promise<{ sent: boolean; reason?: string }> {
  const admin = createAdminClient();

  const { data: row, error: fetchError } = await admin
    .from("chase_email")
    .select("id, person_id, status")
    .eq("id", chaseEmailId)
    .single();

  if (fetchError) {
    throw new Error(`Failed to fetch chase_email ${chaseEmailId}: ${fetchError.message}`);
  }
  if (row.status !== "approved") {
    throw new Error(
      `chase_email ${chaseEmailId} is not approved (status: ${row.status}) -- refusing to send`
    );
  }

  const debt = await getOutstandingDebt(row.person_id);

  if (debt <= 0) {
    const { error: cancelError } = await admin
      .from("chase_email")
      .update({
        status: "cancelled",
        note: "Auto-cancelled: debt was already cleared before send.",
      })
      .eq("id", chaseEmailId)
      .eq("status", "approved");
    if (cancelError) {
      throw new Error(`Failed to cancel chase_email ${chaseEmailId}: ${cancelError.message}`);
    }
    return { sent: false, reason: "debt_cleared" };
  }

  const { error: sendError } = await admin
    .from("chase_email")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .eq("status", "approved");
  if (sendError) {
    throw new Error(`Failed to send chase_email ${chaseEmailId}: ${sendError.message}`);
  }

  return { sent: true };
}

// DC-4's auto-send path: every repeat reminder (sequence_number > 1) that
// generateChaseEmails() pre-approved under CHASE_AUTO_SEND_REPEATS. Never
// touches sequence_number = 1 rows -- those always require manual approval
// (DC-3) and reach `approved` only through a future Phase 7 admin action.
export async function processAutoSends(): Promise<{ sent: number; cancelled: number }> {
  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("chase_email")
    .select("id")
    .eq("status", "approved")
    .gt("sequence_number", 1);

  if (error) {
    throw new Error(`Failed to list auto-sendable chase emails: ${error.message}`);
  }

  let sent = 0;
  let cancelled = 0;
  for (const row of rows ?? []) {
    const result = await sendChaseEmail(row.id);
    if (result.sent) sent++;
    else cancelled++;
  }

  return { sent, cancelled };
}
```

- [ ] **Step 2: Write the integration test**

```typescript
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendChaseEmail, processAutoSends } from "@/lib/chase/send";

const admin = createAdminClient();

async function createPerson() {
  const email = `chase-send-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Chase Send Test Person", email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createAttendance(personId: string, startsAt: Date) {
  const { data: session, error: sessionError } = await admin
    .from("session")
    .insert({ title: "Chase Send Test Session", starts_at: startsAt.toISOString() })
    .select("id")
    .single();
  if (sessionError) throw sessionError;
  const { error: attendanceError } = await admin
    .from("attendance_record")
    .insert({ person_id: personId, session_id: session.id, source: "manual_tick" });
  if (attendanceError) throw attendanceError;
  return session.id as string;
}

async function createApprovedChaseEmail(personId: string, sequenceNumber = 1) {
  const { data, error } = await admin
    .from("chase_email")
    .insert({
      person_id: personId,
      debt_cycle_started_at: new Date().toISOString(),
      sequence_number: sequenceNumber,
      status: "approved",
      subject: "test",
      body: "test",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("sendChaseEmail", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: attendanceError } = await admin
      .from("attendance_record")
      .delete()
      .eq("person_id", personId);
    if (attendanceError) throw attendanceError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("sends when the person still has outstanding debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const chaseEmailId = await createApprovedChaseEmail(personId);

    const result = await sendChaseEmail(chaseEmailId);
    expect(result.sent).toBe(true);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, sent_at")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
  });

  test("cancels instead of sending when debt has already cleared", async () => {
    personId = await createPerson();
    // No attendance at all -- debt is 0.
    const chaseEmailId = await createApprovedChaseEmail(personId);

    const result = await sendChaseEmail(chaseEmailId);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("debt_cleared");

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, sent_at, note")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("cancelled");
    expect(row.sent_at).toBeNull();
    expect(row.note).toContain("Auto-cancelled");
  });

  test("processAutoSends only touches sequence_number > 1 approved rows", async () => {
    personId = await createPerson();
    await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const firstId = await createApprovedChaseEmail(personId, 1);
    const repeatId = await createApprovedChaseEmail(personId, 2);

    const result = await processAutoSends();
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const { data: first, error: firstError } = await admin
      .from("chase_email")
      .select("status")
      .eq("id", firstId)
      .single();
    if (firstError) throw firstError;
    expect(first.status).toBe("approved"); // untouched -- sequence 1 is never auto-sent

    const { data: repeat, error: repeatError } = await admin
      .from("chase_email")
      .select("status")
      .eq("id", repeatId)
      .single();
    if (repeatError) throw repeatError;
    expect(repeat.status).toBe("sent");
  });
});
```

- [ ] **Step 3: Run the integration test**

Run: `npm run test:integration`
Expected: all pass, including these 3 new tests alongside the 13 from Task 3 (16 total).

- [ ] **Step 4: `tsc`/`lint`/`build`**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add lib/chase/send.ts tests/integration/chase-send.spec.ts
git commit -m "$(cat <<'EOF'
feat(chase): implement sendChaseEmail with pre-send debt recheck, processAutoSends

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C3ppv3hK8tNQmnRQkF4XdK
EOF
)"
```

---

### Task 5: Exemption action, cron wiring, `tasks.md` checkoff

**Files:**
- Create: `lib/person/actions.ts`
- Create: `app/api/cron/chase-emails/route.ts`
- Create: `vercel.json`
- Test: `tests/integration/person-exempt.spec.ts`
- Modify: `specs/attendance-payment-chasing/tasks.md`

**Interfaces:**
- Consumes: `requireAdmin()` (`lib/auth/require-admin.ts`, already live), `generateChaseEmails()` (Task 3), `processAutoSends()` (Task 4).
- Produces: `setPersonExempt(input: { personId: string; exempt: boolean; reason?: string }): Promise<void>` — a Server Action, no other task consumes it (Phase 7's future admin UI will).

- [ ] **Step 1: Write `lib/person/actions.ts`**

```typescript
"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

const setPersonExemptSchema = z.object({
  personId: z.string().uuid(),
  exempt: z.boolean(),
  reason: z.string().max(500).optional(),
});

// DC-5: any admin may set or clear a person's exemption; a reason is
// optional. See design.md's "Exemption authority" resolution.
export async function setPersonExempt(
  input: z.infer<typeof setPersonExemptSchema>
): Promise<void> {
  const admin_user = await requireAdmin();
  const parsed = setPersonExemptSchema.parse(input);
  const admin = createAdminClient();

  const { error } = await admin
    .from("person")
    .update({
      is_exempt: parsed.exempt,
      exempt_set_by: parsed.exempt ? admin_user.email : null,
      exempt_set_at: parsed.exempt ? new Date().toISOString() : null,
      exempt_reason: parsed.exempt ? (parsed.reason ?? null) : null,
    })
    .eq("id", parsed.personId);

  if (error) {
    throw new Error(`Failed to update exemption for person ${parsed.personId}: ${error.message}`);
  }
}
```

- [ ] **Step 2: Write the integration test**

```typescript
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { setPersonExempt } from "@/lib/person/actions";

const admin = createAdminClient();

async function createPerson() {
  const email = `exempt-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Exempt Test Person", email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("setPersonExempt", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error } = await admin.from("person").delete().eq("id", personId);
    if (error) throw error;
    personId = "";
  });

  test("setting exempt=true with a reason records set_by/set_at/reason", async () => {
    personId = await createPerson();
    await setPersonExempt({ personId, exempt: true, reason: "Committee member" });

    const { data: row, error } = await admin
      .from("person")
      .select("is_exempt, exempt_set_by, exempt_set_at, exempt_reason")
      .eq("id", personId)
      .single();
    if (error) throw error;

    expect(row.is_exempt).toBe(true);
    expect(row.exempt_set_by).not.toBeNull();
    expect(row.exempt_set_at).not.toBeNull();
    expect(row.exempt_reason).toBe("Committee member");
  });

  test("setting exempt=true without a reason leaves exempt_reason null", async () => {
    personId = await createPerson();
    await setPersonExempt({ personId, exempt: true });

    const { data: row, error } = await admin
      .from("person")
      .select("is_exempt, exempt_reason")
      .eq("id", personId)
      .single();
    if (error) throw error;

    expect(row.is_exempt).toBe(true);
    expect(row.exempt_reason).toBeNull();
  });

  test("clearing exempt=false resets set_by/set_at/reason to null", async () => {
    personId = await createPerson();
    await setPersonExempt({ personId, exempt: true, reason: "temp" });
    await setPersonExempt({ personId, exempt: false });

    const { data: row, error } = await admin
      .from("person")
      .select("is_exempt, exempt_set_by, exempt_set_at, exempt_reason")
      .eq("id", personId)
      .single();
    if (error) throw error;

    expect(row.is_exempt).toBe(false);
    expect(row.exempt_set_by).toBeNull();
    expect(row.exempt_set_at).toBeNull();
    expect(row.exempt_reason).toBeNull();
  });
});
```

Note: this test calls `setPersonExempt` directly in a Node test process, not through a real authenticated request, so `requireAdmin()` will run its real `supabase.auth.getUser()` / `admin_allowlist` check against whatever session exists in that process (none). **Read `lib/auth/require-admin.ts` and `tests/integration/*.spec.ts` before writing this test**: if no existing integration test already exercises a function that calls `requireAdmin()`, this is the first one to hit that path, and it will throw `UnauthorizedError` in a plain Node test context. If that happens, don't work around it by stripping `requireAdmin()` out of `setPersonExempt` (Task 5's whole point is that this write-path is admin-gated, matching `lib/attendance/actions.ts`'s existing convention) — instead, report `BLOCKED` and describe exactly what failed, so the controller can decide whether to test the underlying update logic without the auth wrapper (e.g. a separate non-exported helper) or accept mocking `requireAdmin` for this test file only. Do not silently remove the auth check to make the test pass.

- [ ] **Step 3: Write the cron route**

```typescript
import { NextResponse } from "next/server";
import { generateChaseEmails } from "@/lib/chase/generator";
import { processAutoSends } from "@/lib/chase/send";

// Weekly Vercel Cron target (see vercel.json). Vercel Hobby cron's once/day
// floor is fine here -- see design.md's Scheduling decision, which already
// carves out the weekly chase-email run as a Vercel Cron use case (unlike
// the per-session eActivities sync, which needs pg_cron instead).
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const generated = await generateChaseEmails();
  const sent = await processAutoSends();

  return NextResponse.json({ generated, sent });
}
```

- [ ] **Step 4: Write `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/api/cron/chase-emails",
      "schedule": "0 8 * * 1"
    }
  ]
}
```

(Every Monday at 08:00 UTC.)

- [ ] **Step 5: Check off `tasks.md` Phase 6**

Open `specs/attendance-payment-chasing/tasks.md`. Change every `- [ ]` under `## Phase 6 — Chase Email Generator` (6.1 through 6.5, including both nested Verify sub-items) to `- [x]`. Additionally, in 6.1's line, replace `(config value — blocked on Open Question (a) in design.md)` with `(config value: 7 days, see design.md's Open Question (a) resolution; env var CHASE_THRESHOLD_DAYS)`; in 6.3's trailing parenthetical, replace `(exact policy shape blocked on Open Question (b) in design.md)` with `(policy: env var CHASE_AUTO_SEND_REPEATS, see design.md)`; in 6.4's trailing parenthetical, replace `(exemption authority/audit rule blocked on Open Question (c) in design.md)` with `(any admin, reason optional, see design.md)`.

- [ ] **Step 6: Run the full local verification**

Run: `npx tsc --noEmit && npm run lint && npm run build && npm run test:unit && npm run test:e2e && npm run test:integration`
Expected: all clean/passing.

- [ ] **Step 7: Commit**

```bash
git add lib/person/actions.ts app/api/cron/chase-emails/route.ts vercel.json tests/integration/person-exempt.spec.ts specs/attendance-payment-chasing/tasks.md
git commit -m "$(cat <<'EOF'
feat(chase): exemption action, weekly cron wiring, check off Phase 6

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C3ppv3hK8tNQmnRQkF4XdK
EOF
)"
```
