# Multi-Tenancy Foundation — Schema (Plan 1 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `club`, `admin`, and `club_credential` tables and a `club_id` column on every existing data table, fully backfilled for the existing Judo club, without changing any application code or runtime behavior.

**Architecture:** Five additive Supabase migrations, applied in order, each independently verifiable against the live schema. No `.ts` file in `app/`, `lib/`, or `components/` is touched — `admin_allowlist` keeps being the live authorization table exactly as today. This plan only makes the data model multi-tenant-ready; wiring `requireAdmin()`, routing, business-logic queries, and credentials to actually use `club_id` is Plans 2–4.

**Tech Stack:** PostgreSQL via Supabase migrations (`mcp__supabase__apply_migration`, `mcp__supabase__execute_sql`), Playwright for the verification test (`tests/integration/`).

**Spec:** `docs/superpowers/specs/2026-10-30-multi-tenancy-foundation-design.md`

## Global Constraints

- Deny-all RLS on every new table (`enable row level security` + `force row level security`, no policies) — same posture as every existing table in this project.
- No application code changes in this plan — `admin_allowlist` stays the live authorization mechanism; the new `admin` table is populated but not yet read by any code path.
- The two clubs seeded in this plan: `name = 'Judo'`, `slug = 'judo'` (the existing club — every current row backfills to this one) and `name = 'Taekwondo'`, `slug = 'taekwondo'` (seeded now with zero data, so Plans 2–4 have a second real club to test against).
- Every migration must be safe to re-run conceptually idempotent in intent (uses `where club_id is null` for backfills), even though Supabase tracks applied migrations and won't literally re-run them.

## Review Focus

- **Case-insensitive email uniqueness must survive the constraint swap.** `person`'s current email uniqueness is `UNIQUE (lower(email))`, not a plain column constraint — a naive `unique(club_id, email)` would silently allow `Foo@x.com` and `foo@x.com` in the same club. Pinned in Task 5's test.
- **`cid = NULL` must stay allowed for any number of people in the same club.** `person`'s current `cid` uniqueness is a partial index (`WHERE cid IS NOT NULL`) — non-Imperial members with no CID must never collide on NULL. Pinned in Task 5's test.
- **Every row in every one of the 7 backfilled tables must end up with a non-null `club_id`, and no row must be lost.** A typo'd `WHERE` clause or a forgotten table ships silently-broken multi-tenancy. Pinned in Task 4's test (row-count and NULL-count assertions across all 7 tables).
- **Two clubs must be able to reuse values that used to be globally unique** (the same Pluto `source_row_id`, the same eActivities event id) — this is the entire point of the per-club constraints. Pinned in Task 5's test, using the real Taekwondo club row seeded in Task 1.
- **`admin_allowlist`-based sign-in must keep working, completely unmodified.** This plan adds a parallel `admin` table but must not touch `admin_allowlist` or anything `requireAdmin()` depends on. Pinned in Task 6 by re-running the existing `tests/e2e/admin-auth-gate.spec.ts` unchanged.

---

### Task 1: `club` table + seed Judo and Taekwondo

**Files:**
- Create: `supabase/migrations/20261031090000_create_club_table.sql`

**Interfaces:**
- Produces: `club(id uuid, name text, slug text unique, created_at timestamptz)`. Later tasks look up `(select id from club where slug = 'judo')` and `(select id from club where slug = 'taekwondo')`.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20261031090000_create_club_table.sql
create table club (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

alter table club enable row level security;
alter table club force row level security;

insert into club (name, slug) values
  ('Judo', 'judo'),
  ('Taekwondo', 'taekwondo');
```

- [ ] **Step 2: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "create_club_table"` and the SQL above as `query`.

- [ ] **Step 3: Verify**

Run via `mcp__supabase__execute_sql`:

```sql
select slug, name from club order by slug;
```

Expected: exactly two rows — `('judo', 'Judo')` and `('taekwondo', 'Taekwondo')`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261031090000_create_club_table.sql
git commit -m "feat(db): create club table, seed Judo and Taekwondo"
```

---

### Task 2: `admin` table, backfilled from `admin_allowlist`

**Files:**
- Create: `supabase/migrations/20261031090100_create_admin_table.sql`

**Interfaces:**
- Consumes: `club(id, slug)` from Task 1.
- Produces: `admin(email text, club_id uuid, added_at timestamptz, primary key (email, club_id))`. Not read by any application code yet — Plan 2 switches `requireAdmin()` over to it.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20261031090100_create_admin_table.sql
create table admin (
  email text not null,
  club_id uuid not null references club(id),
  added_at timestamptz not null default now(),
  primary key (email, club_id)
);

alter table admin enable row level security;
alter table admin force row level security;

insert into admin (email, club_id)
select email, (select id from club where slug = 'judo')
from admin_allowlist;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "create_admin_table"`.

- [ ] **Step 3: Verify**

```sql
select count(*) as admin_count from admin;
select count(*) as allowlist_count from admin_allowlist;
```

Expected: both counts equal (every existing admin now also has an `admin` row for the Judo club).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261031090100_create_admin_table.sql
git commit -m "feat(db): create admin table, backfill from admin_allowlist for Judo"
```

---

### Task 3: `club_credential` table (empty)

**Files:**
- Create: `supabase/migrations/20261031090200_create_club_credential_table.sql`

**Interfaces:**
- Consumes: `club(id)` from Task 1.
- Produces: `club_credential(club_id uuid, provider text, credentials jsonb, created_at timestamptz, updated_at timestamptz, primary key (club_id, provider))`. Empty after this task — Plan 4 populates it and wires `lib/eactivities/client.ts`/`lib/pluto/client.ts` to read from it.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20261031090200_create_club_credential_table.sql
create table club_credential (
  club_id uuid not null references club(id),
  provider text not null check (provider in ('eactivities', 'pluto')),
  credentials jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (club_id, provider)
);

alter table club_credential enable row level security;
alter table club_credential force row level security;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "create_club_credential_table"`.

- [ ] **Step 3: Verify**

```sql
select count(*) from club_credential;
```

Expected: `0` (table exists, no rows — that's correct for this task).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261031090200_create_club_credential_table.sql
git commit -m "feat(db): create empty club_credential table"
```

---

### Task 4: `club_id` on every existing data table, backfilled to Judo

**Files:**
- Create: `supabase/migrations/20261031090300_add_club_id_to_existing_tables.sql`

**Interfaces:**
- Consumes: `club(id)` from Task 1.
- Produces: `club_id uuid not null references club(id)` on `person`, `session`, `product`, `purchase`, `attendance_record`, `chase_email`, `sync_cursor`.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20261031090300_add_club_id_to_existing_tables.sql
alter table person add column club_id uuid references club(id);
alter table session add column club_id uuid references club(id);
alter table product add column club_id uuid references club(id);
alter table purchase add column club_id uuid references club(id);
alter table attendance_record add column club_id uuid references club(id);
alter table chase_email add column club_id uuid references club(id);
alter table sync_cursor add column club_id uuid references club(id);

update person set club_id = (select id from club where slug = 'judo') where club_id is null;
update session set club_id = (select id from club where slug = 'judo') where club_id is null;
update product set club_id = (select id from club where slug = 'judo') where club_id is null;
update purchase set club_id = (select id from club where slug = 'judo') where club_id is null;
update attendance_record set club_id = (select id from club where slug = 'judo') where club_id is null;
update chase_email set club_id = (select id from club where slug = 'judo') where club_id is null;
update sync_cursor set club_id = (select id from club where slug = 'judo') where club_id is null;

alter table person alter column club_id set not null;
alter table session alter column club_id set not null;
alter table product alter column club_id set not null;
alter table purchase alter column club_id set not null;
alter table attendance_record alter column club_id set not null;
alter table chase_email alter column club_id set not null;
alter table sync_cursor alter column club_id set not null;
```

- [ ] **Step 2: Apply the migration**

Before applying, capture current row counts so you have a real before/after comparison (not a stale snapshot from when this plan was written):

```sql
select
  (select count(*) from person) as person_total,
  (select count(*) from session) as session_total,
  (select count(*) from product) as product_total,
  (select count(*) from purchase) as purchase_total,
  (select count(*) from attendance_record) as attendance_total,
  (select count(*) from chase_email) as chase_email_total,
  (select count(*) from sync_cursor) as sync_cursor_total;
```

Record these numbers, then use `mcp__supabase__apply_migration` with `name: "add_club_id_to_existing_tables"`.

- [ ] **Step 3: Verify — every row backfilled, none lost**

```sql
select
  (select count(*) from person where club_id is null) as person_null,
  (select count(*) from session where club_id is null) as session_null,
  (select count(*) from product where club_id is null) as product_null,
  (select count(*) from purchase where club_id is null) as purchase_null,
  (select count(*) from attendance_record where club_id is null) as attendance_null,
  (select count(*) from chase_email where club_id is null) as chase_email_null,
  (select count(*) from sync_cursor where club_id is null) as sync_cursor_null,
  (select count(*) from person) as person_total,
  (select count(*) from session) as session_total,
  (select count(*) from purchase) as purchase_total,
  (select count(*) from attendance_record) as attendance_total;
```

Expected: every `*_null` column is `0`, and every total matches the pre-migration counts you recorded in Step 2 exactly (equal, not just "close") — if any total is lower, rows were lost; stop and investigate before continuing. A total that is *higher* than the Step 2 snapshot (e.g. the live app accepted a new signup in between) is fine — that row must still show `club_id` non-null.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261031090300_add_club_id_to_existing_tables.sql
git commit -m "feat(db): add club_id to every existing table, backfilled to Judo"
```

---

### Task 5: Per-club uniqueness — replace global constraints

**Files:**
- Create: `supabase/migrations/20261031090400_make_uniqueness_per_club.sql`
- Test: `tests/integration/multi-tenancy-schema.spec.ts`

**Interfaces:**
- Consumes: `club_id` from Task 4 (must be applied first — this migration assumes every row already has a non-null `club_id`).
- Produces: per-club uniqueness on `person(cid)`, `person(lower(email))`, `session(eactivities_event_id)`, `session(eactivities_signup_id)`, `purchase(source, source_row_id)`, and `sync_cursor`'s primary key.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/multi-tenancy-schema.spec.ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("multi-tenancy schema", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];
  let purchaseIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) await admin.from("person").delete().in("id", personIds);
    if (sessionIds.length) await admin.from("session").delete().in("id", sessionIds);
    if (purchaseIds.length) await admin.from("purchase").delete().in("id", purchaseIds);
    personIds = [];
    sessionIds = [];
    purchaseIds = [];
  });

  test("person email uniqueness is still case-insensitive, now per club", async () => {
    const judo = await clubId("judo");
    const email = `dup-${crypto.randomUUID()}@example.test`;

    const first = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "First", email })
      .select("id")
      .single();
    expect(first.error).toBeNull();
    personIds.push(first.data!.id);

    const secondSameCase = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Second", email });
    expect(secondSameCase.error).not.toBeNull();

    const secondDifferentCase = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Second", email: email.toUpperCase() });
    expect(secondDifferentCase.error).not.toBeNull();
  });

  test("two people in the same club can both have a null cid", async () => {
    const judo = await clubId("judo");

    const first = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "No CID One", email: `nocid1-${crypto.randomUUID()}@example.test`, cid: null })
      .select("id")
      .single();
    expect(first.error).toBeNull();
    personIds.push(first.data!.id);

    const second = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "No CID Two", email: `nocid2-${crypto.randomUUID()}@example.test`, cid: null })
      .select("id")
      .single();
    expect(second.error).toBeNull();
    personIds.push(second.data!.id);
  });

  test("two different clubs can reuse the same eactivities_event_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const sharedEventId = `evt-${crypto.randomUUID()}`;

    const judoSession = await admin
      .from("session")
      .insert({ club_id: judo, title: "Judo session", starts_at: new Date().toISOString(), eactivities_event_id: sharedEventId })
      .select("id")
      .single();
    expect(judoSession.error).toBeNull();
    sessionIds.push(judoSession.data!.id);

    const tkdSession = await admin
      .from("session")
      .insert({ club_id: taekwondo, title: "Taekwondo session", starts_at: new Date().toISOString(), eactivities_event_id: sharedEventId })
      .select("id")
      .single();
    expect(tkdSession.error).toBeNull();
    sessionIds.push(tkdSession.data!.id);
  });

  test("two different clubs can reuse the same purchase source_row_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const sharedRowId = `row-${crypto.randomUUID()}`;

    const judoPurchase = await admin
      .from("purchase")
      .insert({ club_id: judo, source: "pluto_api", source_row_id: sharedRowId, purchased_at: new Date().toISOString() })
      .select("id")
      .single();
    expect(judoPurchase.error).toBeNull();
    purchaseIds.push(judoPurchase.data!.id);

    const tkdPurchase = await admin
      .from("purchase")
      .insert({ club_id: taekwondo, source: "pluto_api", source_row_id: sharedRowId, purchased_at: new Date().toISOString() })
      .select("id")
      .single();
    expect(tkdPurchase.error).toBeNull();
    purchaseIds.push(tkdPurchase.data!.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/multi-tenancy-schema.spec.ts`
Expected: 2 PASS, 2 FAIL. The first two tests (case-insensitive email dedup, multiple null `cid`s) already pass before this migration — the existing global `person_email_unique_idx`/`person_cid_unique_idx` indexes already behave correctly for a single club. The two cross-club-reuse tests FAIL: `session_eactivities_event_id_key` and `purchase_source_source_row_id_key` are still globally unique (not club-scoped), so the *second* insert in each of those two tests — the one for the other club — gets rejected with a duplicate-key error instead of succeeding.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261031090400_make_uniqueness_per_club.sql
drop index person_cid_unique_idx;
create unique index person_club_id_cid_unique_idx on person (club_id, cid) where (cid is not null);

drop index person_email_unique_idx;
create unique index person_club_id_email_unique_idx on person (club_id, lower(email));

alter table session drop constraint session_eactivities_event_id_key;
alter table session add constraint session_club_id_eactivities_event_id_key unique (club_id, eactivities_event_id);

alter table session drop constraint session_eactivities_signup_id_key;
alter table session add constraint session_club_id_eactivities_signup_id_key unique (club_id, eactivities_signup_id);

alter table purchase drop constraint purchase_source_source_row_id_key;
alter table purchase add constraint purchase_club_id_source_source_row_id_key unique (club_id, source, source_row_id);

alter table sync_cursor drop constraint sync_cursor_pkey;
alter table sync_cursor add constraint sync_cursor_pkey primary key (club_id, source);
```

- [ ] **Step 4: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "make_uniqueness_per_club"`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/multi-tenancy-schema.spec.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261031090400_make_uniqueness_per_club.sql tests/integration/multi-tenancy-schema.spec.ts
git commit -m "feat(db): make person/session/purchase/sync_cursor uniqueness per-club"
```

---

### Task 6: Confirm existing auth/app behavior is unchanged

**Files:**
- None created or modified — this task only runs existing suites to confirm Plan 1 changed no runtime behavior.

**Interfaces:**
- Consumes: nothing new. Verifies the Global Constraint that this plan touches zero application code.

- [ ] **Step 1: Run the existing e2e admin-auth-gate suite**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts`
Expected: PASS, unchanged from before this plan — `admin_allowlist`-based sign-in and route gating are untouched.

- [ ] **Step 2: Run the full existing integration suite**

Run: `npx playwright test --config=playwright.integration.config.ts`
Expected: PASS — every pre-existing integration test (chase, attendance, purchase, etc.) still passes, since no `.ts` file changed and every table still has all its pre-existing columns and data, just with `club_id` now also present and populated.

- [ ] **Step 3: Record completion**

No commit needed — this task is verification-only. If either run fails, stop and treat it as a regression introduced by Tasks 1–5, not something to patch around in this task.

---

### Task 7 (added mid-execution — ruling, see ledger): Fix pre-existing integration test fixtures for `club_id`

**Why this task exists:** Task 6 found that the full integration suite drops from passing to 82/97 failing with `null value in column "club_id" ... violates not-null constraint`. This is not a defect in Tasks 1–5's migrations — the NOT NULL constraints are correct and intentional. The gap is that 15 pre-existing test files insert directly into `person`/`session`/`product`/`purchase`/`attendance_record`/`chase_email`/`sync_cursor` via the admin client without ever setting `club_id`, because those tables had no such column when those tests were written. This plan's Global Constraint ("no application code changes") was never meant to extend to test fixtures — it was about not touching `app/`/`lib/`/`components/` behavior — and leaving the test suite broken would undermine every later plan that relies on it passing.

**Files:**
- Modify: `tests/integration/attendance-sync.spec.ts`
- Modify: `tests/integration/attendance-toggle.spec.ts`
- Modify: `tests/integration/chase-approval.spec.ts`
- Modify: `tests/integration/chase-generator.spec.ts`
- Modify: `tests/integration/chase-queries.spec.ts`
- Modify: `tests/integration/chase-send.spec.ts`
- Modify: `tests/integration/csv-import.spec.ts`
- Modify: `tests/integration/debt-calculation.spec.ts`
- Modify: `tests/integration/ingest-purchases.spec.ts`
- Modify: `tests/integration/person-exempt.spec.ts`
- Modify: `tests/integration/person-search.spec.ts`
- Modify: `tests/integration/purchase-matcher.spec.ts`
- Modify: `tests/integration/purchase-upload.spec.ts`
- Modify: `tests/integration/purchase-waivers.spec.ts`
- Modify: `tests/integration/session-list.spec.ts`
- Do NOT modify `tests/integration/multi-tenancy-schema.spec.ts` — it already resolves `club_id` correctly (Task 5).

**Interfaces:**
- Consumes: the `club` table from Task 1 (row with `slug = 'judo'`).
- Produces: every direct `.from(<table>).insert(...)` call in the 15 files above includes `club_id` set to the Judo club's id, so every insert satisfies the NOT NULL constraints from Task 4.

- [ ] **Step 1: In each of the 15 files, add a way to resolve the Judo club id once**

At the top of each file (near the existing `const admin = createAdminClient();` line), add:

```ts
let judoClubId: string;
test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});
```

(If a file already has a `test.beforeAll` or `test.describe.configure`, add this resolution inside the existing one rather than creating a second one — read the file first to check.)

- [ ] **Step 2: Add `club_id: judoClubId` to every direct insert into a club-scoped table**

Search each file for `.from("person").insert(`, `.from("session").insert(`, `.from("product").insert(`, `.from("purchase").insert(`, `.from("attendance_record").insert(`, `.from("chase_email").insert(`, `.from("sync_cursor").insert(`, and `.from("purchase_upload").insert(` (check whether `purchase_upload` has its own `club_id` — if the live schema shows it doesn't, skip it and note that in your report). Add `club_id: judoClubId` as a field in the object passed to `.insert(...)`, for every such call, in every one of the 15 files. A batched insert (an array of objects) needs `club_id` added to every object in the array, not just the first.

- [ ] **Step 3: Run the full integration suite**

Run: `npx playwright test --config=playwright.integration.config.ts`
Expected: PASS, matching (or exceeding) whatever passing count existed before Tasks 1–5 were applied — if you don't know that baseline, the bar is simply: zero failures with `club_id` NOT NULL violations, and no test that previously had nothing to do with `club_id` now fails for an unrelated reason.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/attendance-sync.spec.ts tests/integration/attendance-toggle.spec.ts tests/integration/chase-approval.spec.ts tests/integration/chase-generator.spec.ts tests/integration/chase-queries.spec.ts tests/integration/chase-send.spec.ts tests/integration/csv-import.spec.ts tests/integration/debt-calculation.spec.ts tests/integration/ingest-purchases.spec.ts tests/integration/person-exempt.spec.ts tests/integration/person-search.spec.ts tests/integration/purchase-matcher.spec.ts tests/integration/purchase-upload.spec.ts tests/integration/purchase-waivers.spec.ts tests/integration/session-list.spec.ts
git commit -m "test: resolve Judo club_id in pre-existing integration test fixtures

Tasks 1-5 made club_id NOT NULL on every club-scoped table. These 15
test files predate that and insert directly via the admin client
without it. Fixes the 82/97 integration-suite regression Task 6 found."
```
