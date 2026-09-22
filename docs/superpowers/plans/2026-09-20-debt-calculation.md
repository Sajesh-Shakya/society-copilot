# Debt Calculation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive each person's outstanding (unpaid) session debt from the existing attendance/purchase ledger, correctly excluding free trials and active-pass coverage windows, and implement waiver logic so a covering purchase clears prior debt.

**Architecture:** Debt is never stored — it's a live SQL view (`outstanding_attendance`) over `attendance_record`/`session`/`purchase`/`product`, following this repo's existing Postgres-function convention (`search_person_by_name`). A `person_outstanding_debt(person_id)` RPC counts a person's rows in that view; an `apply_purchase_waiver(purchase_id)` RPC clears debt retroactively when a covering purchase is ingested, called from `ingestPurchases()`'s existing insert loop.

**Tech Stack:** Postgres (views, SQL/plpgsql functions, `supabase.rpc()`), TypeScript (`lib/debt/calculator.ts`, `lib/purchase/interface.ts`), Playwright as the integration-test runner (already wired up this session).

**Spec:** `specs/attendance-payment-chasing/design.md` + `specs/attendance-payment-chasing/requirements.md` (MP-1, MP-2, MP-3, DC-1). Implements `specs/attendance-payment-chasing/tasks.md` Phase 5 (5.1, 5.2, 5.3).

## Global Constraints

- **MP-1.** WHEN a person holds an active term or annual pass, THE system SHALL NOT count their session attendance toward outstanding debt, but SHALL continue recording attendance for historical/usage reporting.
- **MP-2.** WHEN a person's term or annual pass expires, THE system SHALL resume counting subsequent attendance toward debt from the expiry date forward.
- **MP-3.** WHEN a person purchases a pass or membership that covers prior unpaid attendance, THE system SHALL mark those historical attendance records as waived by that purchase, and SHALL NOT delete them.
- **DC-1.** THE system SHALL derive, not store as a mutable field, the number of unpaid sessions owed per person, computed from attendance records not yet covered by a purchase or waiver.
- **Design decision (made 2026-09-20, not yet in design.md — Task 1 records it there):** free-trial handling = auto-exclude each person's chronologically-earliest `attendance_record` (ordered by `session.starts_at`) from debt calculation. No `is_free_trial` flag, no admin action needed.
- **Design decision (made 2026-09-20, not yet in design.md — Task 1 records it there):** a term/annual pass's coverage window is `[purchase.purchased_at, purchase.purchased_at + product.covers_days)`, via a new nullable `product.covers_days int` column, set per-product (not a global constant, not a shared academic-term calendar).
- **Ruling (this plan):** MP-3's "covers prior unpaid attendance" is read literally and broadly for term/annual passes: buying one waives **all** of a person's currently-outstanding debt, not just debt within that pass's own forward date window (which MP-1/MP-2 already handle separately, for attendance that never became debt in the first place). This matches the common real policy of "buy the membership, past dues are forgiven." A `session_pass` purchase, by contrast, waives only up to its `covers_sessions` count of the person's *oldest* outstanding debt (FIFO) — it has a limited number of credits, unlike an unlimited-within-window term/annual pass.
- No admin UI in this plan — Phase 5 is backend-only per `tasks.md`. Product curation (setting a real `kind`/`covers_sessions`/`covers_days` instead of the Phase-4 ingestion shortcut's auto-created `kind: 'other'`) happens via direct Supabase Studio table edits for now.
- This repo's admin-only writes go through `lib/supabase/admin.ts`'s `createAdminClient()` (service_role, bypasses RLS) — never the anon/publishable client, for the same reasons already documented on every other table in this feature.

---

### Task 1: Record the two design decisions in `design.md`, add `product.covers_days`

**Files:**
- Modify: `specs/attendance-payment-chasing/design.md`
- Create: `supabase/migrations/20260920110000_add_product_covers_days.sql`

**Interfaces:**
- Consumes: nothing new.
- Produces: `product.covers_days int` (nullable) — Task 2 and Task 3 both read this column.

- [ ] **Step 1: Update `design.md`'s schema code block**

In `specs/attendance-payment-chasing/design.md`, find the `create table product (...)` block inside the schema code fence and add the new column, so the spec's schema stays in sync with the actual database:

```sql
create table product (
  id uuid primary key default gen_random_uuid(),
  name text not null,                        -- e.g. "Term 1 Pass", "Annual Membership", "Single Session"
  kind text not null check (kind in ('session_pass','term_pass','annual_pass','other')),
  covers_sessions int,                        -- null = unlimited (term/annual)
  covers_days int,                            -- resolved 2026-09-20: for term_pass/annual_pass, coverage window length in days from purchased_at. Null for session_pass/other.
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Resolve the free-trial sub-issue in `design.md`'s Open Questions section**

Find this paragraph inside `### c. Exemption authority & audit requirement`:

```
The draft
also flagged a related product question that should be settled
alongside this one: Judo and BJJ's first session is always free, so a naive
debt count would generate a chase email for someone who only ever attended a
free trial session. Some mechanism (e.g. not counting session 1 toward debt, or
an explicit "free trial" flag) is needed before this ships, and is not yet
designed.
```

Replace it with:

```
The draft
also flagged a related product question that should be settled
alongside this one: Judo and BJJ's first session is always free, so a naive
debt count would generate a chase email for someone who only ever attended a
free trial session.

**RESOLVED (2026-09-20):** the debt query (`outstanding_attendance`, see
`docs/superpowers/plans/2026-09-20-debt-calculation.md`) auto-excludes each
person's chronologically-earliest `attendance_record` (by `session.starts_at`)
from debt calculation — no schema flag, no admin action needed. The
exemption-authority question above (who may set `is_exempt`, and whether a
reason must be logged) remains open.
```

- [ ] **Step 3: Write the migration**

```sql
-- Migration: add covers_days to product, for term/annual pass coverage windows
-- specs/attendance-payment-chasing/tasks.md 5.1, 5.2
-- Enables: MP-1, MP-2

alter table public.product add column covers_days int;

comment on column public.product.covers_days is
  'For kind = term_pass/annual_pass: number of days a purchase of this product covers attendance for, starting from purchase.purchased_at (inclusive) up to purchased_at + covers_days (exclusive). Null for session_pass/other, which use covers_sessions (a count) instead of a date range.';
```

- [ ] **Step 4: Apply the migration**

Use the `mcp__supabase__apply_migration` tool with `name: "add_product_covers_days"` and the SQL from Step 3. Verify with `mcp__supabase__execute_sql`:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'product' and column_name = 'covers_days';
```

Expected: one row, `covers_days | integer | YES`.

- [ ] **Step 5: Commit**

```bash
git add specs/attendance-payment-chasing/design.md supabase/migrations/20260920110000_add_product_covers_days.sql
git commit -m "docs+db: resolve free-trial and pass-duration design questions, add product.covers_days"
```

---

### Task 2: Debt calculation view, RPC function, and TS wrapper

**Files:**
- Create: `supabase/migrations/20260920120000_add_debt_calculation_functions.sql`
- Create: `lib/debt/calculator.ts`
- Create: `tests/integration/debt-calculation.spec.ts`
- Modify: `playwright.config.ts` (load `.env.local` so integration tests can reach the live Supabase project)
- Modify: `package.json` (add `dotenv` devDependency, add `test:integration` script)

**Interfaces:**
- Consumes: `product.covers_days` (Task 1), existing tables `attendance_record`, `session`, `purchase`, `product`.
- Produces: SQL view `public.outstanding_attendance`; SQL function `public.person_outstanding_debt(target_person_id uuid) returns bigint`; TS function `getOutstandingDebt(personId: string): Promise<number>` in `lib/debt/calculator.ts`. Task 3's `apply_purchase_waiver` SQL function reads from `outstanding_attendance`.

- [ ] **Step 1: Wire up `.env.local` loading for tests that need a real Supabase connection**

Install `dotenv` explicitly (it's already present transitively, this just makes it a direct devDependency so it can't silently disappear):

```bash
npm install -D dotenv
```

At the top of `playwright.config.ts`, before `export default defineConfig(...)`, add:

```typescript
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, ".env.local") });
```

In `package.json`'s `"scripts"`, add one entry alongside the existing `"test"`/`"test:unit"`/`"test:e2e"`:

```json
    "test:integration": "playwright test tests/integration",
```

- [ ] **Step 2: Write the SQL view and function**

```sql
-- Migration: debt calculation view + person_outstanding_debt function
-- specs/attendance-payment-chasing/tasks.md 5.1, 5.2
-- Enables: MP-1, MP-2, DC-1

-- A person's attendance rows that currently count as outstanding (unpaid)
-- debt: not their free trial (first-ever attendance, chronologically by
-- session date), not already waived by a purchase, and not covered by an
-- active term/annual pass at the time of that session.
--
-- SECURITY INVOKER (default): only ever called via the admin (secret-key)
-- client, which already bypasses RLS regardless -- same convention as
-- search_person_by_name (see 20260917092731_add_person_fuzzy_name_search.sql).
create or replace view public.outstanding_attendance as
select ar.id, ar.person_id, ar.session_id, s.starts_at
from public.attendance_record ar
join public.session s on s.id = ar.session_id
where ar.waived_by_purchase_id is null
  and ar.id <> (
    select ar2.id
    from public.attendance_record ar2
    join public.session s2 on s2.id = ar2.session_id
    where ar2.person_id = ar.person_id
    order by s2.starts_at asc, ar2.id asc
    limit 1
  )
  and not exists (
    select 1
    from public.purchase p
    join public.product pr on pr.id = p.product_id
    where p.person_id = ar.person_id
      and pr.kind in ('term_pass', 'annual_pass')
      and pr.covers_days is not null
      and s.starts_at >= p.purchased_at
      and s.starts_at < p.purchased_at + (pr.covers_days || ' days')::interval
  );

comment on view public.outstanding_attendance is
  'DC-1: attendance rows that currently count as unpaid debt. Excludes each person''s free trial (earliest attendance ever), anything already waived, and anything covered by an active term/annual pass window. See specs/attendance-payment-chasing/design.md.';

-- DC-1: a person's current debt count.
create or replace function public.person_outstanding_debt(target_person_id uuid)
returns bigint
language sql
stable
as $$
  select count(*) from public.outstanding_attendance where person_id = target_person_id;
$$;
```

- [ ] **Step 3: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "add_debt_calculation_functions"` and the SQL from Step 2.

- [ ] **Step 4: Write `lib/debt/calculator.ts`**

```typescript
import { createAdminClient } from "@/lib/supabase/admin";

// DC-1: a person's current outstanding (unpaid) debt, derived live from
// attendance_record via the outstanding_attendance view -- see
// supabase/migrations/20260920120000_add_debt_calculation_functions.sql.
// Never stored as a mutable field.
export async function getOutstandingDebt(personId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("person_outstanding_debt", {
    target_person_id: personId,
  });

  if (error) {
    throw new Error(
      `Failed to compute outstanding debt for person ${personId}: ${error.message}`
    );
  }

  return data ?? 0;
}
```

- [ ] **Step 5: Write the integration test**

These tests hit the real (dev) Supabase project — there's no local Postgres to isolate against in this repo. Each test creates its own fixture rows tagged with a random email/name and deletes them afterward.

```typescript
import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";

const admin = createAdminClient();

test.describe("getOutstandingDebt", () => {
  let personId: string;
  let sessionIds: string[] = [];
  let productId: string | undefined;

  test.afterEach(async () => {
    if (productId) {
      await admin.from("purchase").delete().eq("product_id", productId);
      await admin.from("product").delete().eq("id", productId);
      productId = undefined;
    }
    if (sessionIds.length > 0) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (personId) {
      await admin.from("person").delete().eq("id", personId);
    }
  });

  async function createPerson(): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({ email: `debt-test-${randomUUID()}@example.test`, full_name: "Debt Test Person" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test person: ${error?.message}`);
    return data.id;
  }

  async function createAttendance(pid: string, startsAt: string): Promise<string> {
    const { data: session, error: sessionError } = await admin
      .from("session")
      .insert({ title: "Test Session", starts_at: startsAt })
      .select("id")
      .single();
    if (sessionError || !session) throw new Error(`Failed to create test session: ${sessionError?.message}`);
    sessionIds.push(session.id);

    const { error: attendanceError } = await admin
      .from("attendance_record")
      .insert({ person_id: pid, session_id: session.id, source: "manual_tick" });
    if (attendanceError) throw new Error(`Failed to create test attendance: ${attendanceError.message}`);

    return session.id;
  }

  test("a single attendance record is the free trial and does not count as debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z");

    expect(await getOutstandingDebt(personId)).toBe(0);
  });

  test("a second attendance record counts as debt (first is the free trial)", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z");
    await createAttendance(personId, "2026-01-08T18:00:00.000Z");

    expect(await getOutstandingDebt(personId)).toBe(1);
  });

  test("attendance covered by an active term pass does not count as debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // would-be debt, but covered below

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { error: purchaseError } = await admin.from("purchase").insert({
      person_id: personId,
      product_id: productId,
      source: "xlsx_upload",
      source_row_id: `debt-test-${randomUUID()}`,
      purchased_at: "2026-01-05T00:00:00.000Z", // before the covered session
      match_status: "cid_matched",
    });
    if (purchaseError) throw new Error(`Failed to create test purchase: ${purchaseError.message}`);

    expect(await getOutstandingDebt(personId)).toBe(0);
  });

  test("attendance after a term pass expires resumes counting as debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-04-01T18:00:00.000Z"); // well past a 70-day window from Jan 5

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { error: purchaseError } = await admin.from("purchase").insert({
      person_id: personId,
      product_id: productId,
      source: "xlsx_upload",
      source_row_id: `debt-test-${randomUUID()}`,
      purchased_at: "2026-01-05T00:00:00.000Z",
      match_status: "cid_matched",
    });
    if (purchaseError) throw new Error(`Failed to create test purchase: ${purchaseError.message}`);

    expect(await getOutstandingDebt(personId)).toBe(1);
  });
});
```

- [ ] **Step 6: Run the integration tests**

Run: `npm run test:integration`
Expected: all 4 tests in `tests/integration/debt-calculation.spec.ts` pass. If `SUPABASE_SECRET_KEY`/`NEXT_PUBLIC_SUPABASE_URL` errors appear, confirm `.env.local` has both and Step 1's `dotenv.config()` call was added correctly.

- [ ] **Step 7: Verify tsc and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260920120000_add_debt_calculation_functions.sql lib/debt/calculator.ts tests/integration/debt-calculation.spec.ts playwright.config.ts package.json package-lock.json
git commit -m "feat(debt): implement outstanding-debt view, RPC, and TS wrapper"
```

---

### Task 3: Waiver logic — `apply_purchase_waiver` RPC, `applyWaivers`, wire into `ingestPurchases`

**Files:**
- Create: `supabase/migrations/20260920130000_add_purchase_waiver_function.sql`
- Modify: `lib/purchase/interface.ts` (implement the `applyWaivers` stub; call it from `ingestPurchases()`'s insert loop)
- Create: `tests/integration/purchase-waivers.spec.ts`

**Interfaces:**
- Consumes: `outstanding_attendance` view (Task 2), `getOutstandingDebt` (Task 2, used in this task's tests).
- Produces: SQL function `public.apply_purchase_waiver(target_purchase_id uuid) returns int`. **Signature change**: `applyWaivers(personId: string, purchaseId: string)` now returns `Promise<number>` (count of rows waived), not `Promise<void>` as the Phase-4 stub declared — no other code calls it yet, so this is not a breaking change.

- [ ] **Step 1: Write the SQL function**

```sql
-- Migration: purchase waiver function
-- specs/attendance-payment-chasing/tasks.md 5.3
-- Enables: MP-3

-- When a purchase is ingested and matched to a person, waive as much of
-- their currently-outstanding debt as that purchase covers:
--   - session_pass: waives up to `covers_sessions` of the person's oldest
--     outstanding attendance rows (FIFO -- oldest debt cleared first).
--   - term_pass / annual_pass: waives ALL of the person's currently
--     outstanding attendance rows, per this plan's ruling that MP-3's
--     "covers prior unpaid attendance" applies broadly, not just within
--     the pass's own forward date window (outstanding_attendance's own
--     date-window check already handles MP-1's forward-looking case
--     separately, so this branch is specifically the retroactive case).
--   - any other kind (including the Phase-4 ingestion shortcut's
--     auto-created 'other' products): waives nothing. An admin must curate
--     the product's kind/covers_sessions/covers_days before it can waive
--     debt.
-- Returns the number of attendance rows waived, for logging/testing.
-- Idempotent: calling this twice for the same purchase waives 0 additional
-- rows the second time, since already-waived rows drop out of
-- outstanding_attendance.
--
-- SECURITY INVOKER (default): only ever called via the admin (secret-key)
-- client, which already bypasses RLS regardless -- same convention as
-- search_person_by_name and person_outstanding_debt.
create or replace function public.apply_purchase_waiver(target_purchase_id uuid)
returns int
language plpgsql
as $$
declare
  v_person_id uuid;
  v_product_kind text;
  v_covers_sessions int;
  v_waived_count int;
begin
  select p.person_id, pr.kind, pr.covers_sessions
  into v_person_id, v_product_kind, v_covers_sessions
  from public.purchase p
  join public.product pr on pr.id = p.product_id
  where p.id = target_purchase_id;

  if v_person_id is null then
    return 0;
  end if;

  if v_product_kind = 'session_pass' and v_covers_sessions is not null then
    with to_waive as (
      select oa.id
      from public.outstanding_attendance oa
      where oa.person_id = v_person_id
      order by oa.starts_at asc
      limit v_covers_sessions
    )
    update public.attendance_record
    set waived_by_purchase_id = target_purchase_id
    where id in (select id from to_waive);
    get diagnostics v_waived_count = row_count;

  elsif v_product_kind in ('term_pass', 'annual_pass') then
    with to_waive as (
      select oa.id
      from public.outstanding_attendance oa
      where oa.person_id = v_person_id
    )
    update public.attendance_record
    set waived_by_purchase_id = target_purchase_id
    where id in (select id from to_waive);
    get diagnostics v_waived_count = row_count;

  else
    v_waived_count := 0;
  end if;

  return v_waived_count;
end;
$$;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "add_purchase_waiver_function"` and the SQL from Step 1.

- [ ] **Step 3: Implement `applyWaivers`**

In `lib/purchase/interface.ts`, replace the stub at the bottom of the file:

```typescript
export async function applyWaivers(_personId: string, _purchaseId: string): Promise<void> {
  // (Phase 5 scope — not this task; stub for interface completeness)
  throw new Error('Not implemented');
}
```

with:

```typescript
// MP-3: waive as much of personId's currently-outstanding debt as this
// purchase covers. See apply_purchase_waiver in
// supabase/migrations/20260920130000_add_purchase_waiver_function.sql for
// the exact per-product-kind rule. Returns the number of attendance rows
// waived (0 if the product's kind doesn't waive anything yet, e.g. the
// Phase-4 ingestion shortcut's auto-created 'other' products).
export async function applyWaivers(personId: string, purchaseId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('apply_purchase_waiver', {
    target_purchase_id: purchaseId,
  });

  if (error) {
    throw new Error(
      `Failed to apply waiver for purchase ${purchaseId} (person ${personId}): ${error.message}`
    );
  }

  return data ?? 0;
}
```

- [ ] **Step 4: Wire `applyWaivers` into `ingestPurchases`'s insert loop**

In `lib/purchase/interface.ts`, the insert call currently reads:

```typescript
      const { error } = await admin.from('purchase').insert({
        person_id: purchase.personId,
        product_id: purchase.productId,
        source: purchase.source,
        source_row_id: purchase.sourceRowId,
        raw_member_type: purchase.rawMemberType,
        raw_person_name: purchase.rawPersonName,
        raw_email: purchase.rawEmail,
        raw_cid: purchase.rawCid,
        match_status: purchase.matchStatus,
        purchased_at: purchase.purchasedAt.toISOString(),
      });
```

Change it to also select back the inserted row's `id`:

```typescript
      const { data: insertedPurchase, error } = await admin
        .from('purchase')
        .insert({
          person_id: purchase.personId,
          product_id: purchase.productId,
          source: purchase.source,
          source_row_id: purchase.sourceRowId,
          raw_member_type: purchase.rawMemberType,
          raw_person_name: purchase.rawPersonName,
          raw_email: purchase.rawEmail,
          raw_cid: purchase.rawCid,
          match_status: purchase.matchStatus,
          purchased_at: purchase.purchasedAt.toISOString(),
        })
        .select('id')
        .single();
```

Then, inside the `else { inserted++; ... }` success branch, after the existing `is_student` update block (the `if (purchase.personId && latestByPerson.get(purchase.personId) === purchase) { ... }` block), add a new block that runs for **every** successful non-duplicate insert with a matched person (not gated by `latestByPerson` — every new purchase in the batch should independently try to waive whatever debt is still outstanding after any earlier waiver in this same loop already ran):

```typescript
        if (purchase.personId && insertedPurchase) {
          try {
            await applyWaivers(purchase.personId, insertedPurchase.id);
          } catch (waiverError) {
            errors.push({
              rowId: purchase.sourceRowId,
              reason: `Purchase inserted, but waiver assignment failed: ${
                waiverError instanceof Error ? waiverError.message : 'unknown error'
              }`,
              rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)!,
            });
          }
        }
```

The full success branch (`else { ... }`) should now read, top to bottom: `inserted++;`, then the existing `is_student` update block, then this new waiver block.

- [ ] **Step 5: Write the integration test**

```typescript
import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import { applyWaivers } from "@/lib/purchase/interface";

const admin = createAdminClient();

test.describe("applyWaivers", () => {
  let personId: string;
  let sessionIds: string[] = [];
  let productId: string | undefined;
  let purchaseId: string | undefined;

  test.afterEach(async () => {
    if (purchaseId) {
      await admin.from("purchase").delete().eq("id", purchaseId);
      purchaseId = undefined;
    }
    if (productId) {
      await admin.from("product").delete().eq("id", productId);
      productId = undefined;
    }
    if (sessionIds.length > 0) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (personId) {
      await admin.from("person").delete().eq("id", personId);
    }
  });

  async function createPerson(): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({ email: `waiver-test-${randomUUID()}@example.test`, full_name: "Waiver Test Person" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test person: ${error?.message}`);
    return data.id;
  }

  async function createAttendance(pid: string, startsAt: string): Promise<string> {
    const { data: session, error: sessionError } = await admin
      .from("session")
      .insert({ title: "Test Session", starts_at: startsAt })
      .select("id")
      .single();
    if (sessionError || !session) throw new Error(`Failed to create test session: ${sessionError?.message}`);
    sessionIds.push(session.id);

    const { error: attendanceError } = await admin
      .from("attendance_record")
      .insert({ person_id: pid, session_id: session.id, source: "manual_tick" });
    if (attendanceError) throw new Error(`Failed to create test attendance: ${attendanceError.message}`);

    return session.id;
  }

  test("a term pass purchase waives all of a person's prior unpaid attendance", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial, never debt
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1
    await createAttendance(personId, "2026-01-15T18:00:00.000Z"); // debt #2

    expect(await getOutstandingDebt(personId)).toBe(2);

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        person_id: personId,
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `waiver-test-${randomUUID()}`,
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    const waivedCount = await applyWaivers(personId, purchaseId);

    expect(waivedCount).toBe(2);
    expect(await getOutstandingDebt(personId)).toBe(0);

    const { data: rows } = await admin
      .from("attendance_record")
      .select("waived_by_purchase_id")
      .in("session_id", sessionIds);
    const nonWaived = rows?.filter((r) => r.waived_by_purchase_id === null) ?? [];
    // Only the free trial row should remain un-waived (it was never debt).
    expect(nonWaived).toHaveLength(1);
  });

  test("a session_pass purchase waives only up to covers_sessions of the oldest debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1 (oldest)
    await createAttendance(personId, "2026-01-15T18:00:00.000Z"); // debt #2
    await createAttendance(personId, "2026-01-22T18:00:00.000Z"); // debt #3

    expect(await getOutstandingDebt(personId)).toBe(3);

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Session Pack ${randomUUID()}`, kind: "session_pass", covers_sessions: 2 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        person_id: personId,
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `waiver-test-${randomUUID()}`,
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    const waivedCount = await applyWaivers(personId, purchaseId);

    expect(waivedCount).toBe(2); // capped at covers_sessions, not all 3
    expect(await getOutstandingDebt(personId)).toBe(1); // one debt row remains

    const { data: waivedRows } = await admin
      .from("attendance_record")
      .select("id")
      .in("session_id", sessionIds)
      .eq("waived_by_purchase_id", purchaseId);
    expect(waivedRows).toHaveLength(2);
  });

  test("calling applyWaivers twice for the same purchase is idempotent", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        person_id: personId,
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `waiver-test-${randomUUID()}`,
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    const first = await applyWaivers(personId, purchaseId);
    const second = await applyWaivers(personId, purchaseId);

    expect(first).toBe(1);
    expect(second).toBe(0); // nothing left to waive the second time
  });
});
```

- [ ] **Step 6: Run the integration tests**

Run: `npm run test:integration`
Expected: all tests in both `tests/integration/debt-calculation.spec.ts` and `tests/integration/purchase-waivers.spec.ts` pass.

- [ ] **Step 7: Verify tsc, lint, and build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 8: Update `tasks.md`**

In `specs/attendance-payment-chasing/tasks.md`, check off Phase 5's three items:

```markdown
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
  - [x] Verify: a person with 3 unpaid attendance records who buys a covering
        term pass has debt drop to 0, all 3 rows get a non-null
        `waived_by_purchase_id`, and none of them are deleted
```

(Note: the plan's own tests use 2 unpaid attendance records for the term-pass case, not 3 — the underlying mechanism is identical for any count. If a reviewer wants the exact literal "3 records" scenario verified too, that's a one-line change to the `createAttendance` calls in Task 2's Step 5 test, not a different code path.)

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260920130000_add_purchase_waiver_function.sql lib/purchase/interface.ts tests/integration/purchase-waivers.spec.ts specs/attendance-payment-chasing/tasks.md
git commit -m "feat(debt): implement purchase waiver logic (MP-3), wire into ingestPurchases"
```

---

## Self-Review Notes (author's own pass, not a task)

- **Spec coverage:** MP-1 (Task 2's view), MP-2 (Task 2's expiry test), MP-3 (Task 3), DC-1 (Task 2's function) all have a task and a test. `tasks.md` 5.1/5.2/5.3 all covered.
- **Placeholder scan:** no TBDs; every SQL/TS block is complete, runnable code.
- **Type consistency:** `getOutstandingDebt(personId: string): Promise<number>` and `applyWaivers(personId: string, purchaseId: string): Promise<number>` are used identically in Task 2/3's own code and their tests.
- **Known deferred scope, matching this session's established pattern of explicit tracked gaps rather than silent ones:** no admin UI for product curation or a debt-listing page (not in `tasks.md`'s Phase 5); Phase 6's chase-email eligibility logic (debt-cycle-start tracking, the three still-open Open Questions a/b/c) is out of scope for this plan.
