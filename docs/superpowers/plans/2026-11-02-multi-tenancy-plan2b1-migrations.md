# Multi-Tenancy Plan 2b-1: Scoping Migrations + Their Required Caller Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every database-level change Plan 2b-2 (the business-logic scoping sweep) will depend on — the same-club FK backstop, `product`'s per-club uniqueness, `purchase_upload` gaining `club_id`, and the two breaking function-signature changes (`search_person_by_name`, `reapply_waivers_for_everyone_with_debt`) — with each breaking change shipped in the SAME task as its only caller's fix, never as a standalone migration that outruns the code using it.

**Architecture:** This plan exists because of a lesson learned the hard way in an earlier plan: a migration that tightens a constraint or changes a function signature, applied before the application code that depends on the old shape is updated, breaks production between "migration applied" and "app code deployed" — and nothing in a task-level test run catches it if the test doesn't exercise that exact path. Every task here that changes a signature or a constraint ends with the one caller that uses it already updated and tested in the same commit. Two migrations (the view changes, `toggle_attendance`'s fix) are purely additive/non-breaking and ship standalone.

**Tech Stack:** PostgreSQL via Supabase migrations, Playwright for tests.

**Spec:** `docs/superpowers/specs/2026-11-01-multi-tenancy-plan2-design.md` (Plan 2b section) — this plan implements its Migrations B–F plus the minimum caller fixes needed for nothing to break; the full business-logic scoping sweep (Groups 1–4) is Plan 2b-2, not this plan.

## Global Constraints

- No task in this plan may apply a migration that changes an existing function's signature or a table's constraint in a way that breaks an existing caller, without updating that caller in the SAME task.
- This plan does not thread real per-request `clubId` through business logic — that's Plan 2b-2. Where a caller fix is required here, it's the minimum change to keep working correctly for Judo (the only club with real data), not a full scoping conversion.
- Every migration's grants (who can `EXECUTE`) must be preserved exactly from the current live definition unless a task explicitly says otherwise — don't narrow or widen access as a side effect of a signature change.
- `lib/supabase/default-club.ts` (the Plan 1 hotfix) is NOT touched or removed in this plan — it's still in use by code this plan doesn't modify, and removing it is Plan 2b-3's job, after Plan 2b-2 converts every remaining caller.

## Review Focus

- **A migration that changes a function signature must never be applied without its caller already updated in the same commit** — this is the exact failure mode that caused a production incident in an earlier plan. Pinned by this plan's own task sequencing (Tasks 5 and 7 bundle the migration with its caller) and by each such task's verification step explicitly testing the real caller path, not just the raw SQL function.
- **`product`'s uniqueness moving from global to per-club must not silently drop the existing upsert's ability to find/create a product by name** — a wrong `onConflict` target after the constraint changes would make every XLSX upload fail. Pinned in Task 2.
- **`purchase_upload` gaining a NOT NULL `club_id` must not repeat the exact Plan 1 incident** (a new NOT NULL column with no default, on a table a live code path still inserts into without supplying it). Pinned in Task 3.
- **`toggle_attendance`'s fix must correctly derive `club_id` for a NON-Judo session** — the whole point of this fix is making the function work for a second club; a test that only exercises Judo wouldn't catch a bug that happens to coincide with Judo's data. Pinned in Task 4 with a real Taekwondo-session test.
- **The same-club foreign keys (Task 1) must not reject any of Judo's existing real data** — since all current data is Judo's own, every FK should be satisfiable trivially; if Task 1's migration fails to apply because of a data mismatch, that's a sign of a conceptual error in the FK design, not something to force through. Pinned in Task 1's apply step.

---

### Task 1: Same-club foreign key backstop

**Files:**
- Create: `supabase/migrations/20261102090000_add_same_club_foreign_keys.sql`
- Test: `tests/integration/same-club-fk.spec.ts`

**Interfaces:**
- Consumes: the existing `club_id` columns from Plan 1 (already NOT NULL on all 7 tables).
- Produces: `unique(id, club_id)` on `person`, `session`, `product`, `purchase`; composite foreign keys ensuring `attendance_record`, `purchase`, `chase_email`, and `purchase_upload` can never reference a row belonging to a different club than their own `club_id`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/same-club-fk.spec.ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("same-club foreign keys", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) await admin.from("person").delete().in("id", personIds);
    if (sessionIds.length) await admin.from("session").delete().in("id", sessionIds);
    personIds = [];
    sessionIds = [];
  });

  test("an attendance_record cannot reference a person from a different club than its own club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");

    const person = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Judo Person", email: `fk-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    personIds.push(person.data!.id);

    const session = await admin
      .from("session")
      .insert({ club_id: taekwondo, title: "Taekwondo Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    sessionIds.push(session.data!.id);

    // attendance_record claims club_id = taekwondo (matching the session),
    // but person_id belongs to judo -- the composite FK on
    // (person_id, club_id) -> person(id, club_id) must reject this, since
    // no person row exists with (id = person.data.id, club_id = taekwondo).
    const { error } = await admin.from("attendance_record").insert({
      club_id: taekwondo,
      person_id: person.data!.id,
      session_id: session.data!.id,
      source: "manual_tick",
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503"); // foreign_key_violation
  });

  test("an attendance_record CAN reference a person and session from the same club", async () => {
    const judo = await clubId("judo");

    const person = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Judo Person 2", email: `fk-ok-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    personIds.push(person.data!.id);

    const session = await admin
      .from("session")
      .insert({ club_id: judo, title: "Judo Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    sessionIds.push(session.data!.id);

    const { error } = await admin.from("attendance_record").insert({
      club_id: judo,
      person_id: person.data!.id,
      session_id: session.data!.id,
      source: "manual_tick",
    });
    expect(error).toBeNull();
    await admin.from("attendance_record").delete().eq("person_id", person.data!.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/same-club-fk.spec.ts`
Expected: FAIL on the first test — without the composite FK, the cross-club insert currently succeeds (no `error`), so `expect(error).not.toBeNull()` fails.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261102090000_add_same_club_foreign_keys.sql
alter table person add constraint person_id_club_id_key unique (id, club_id);
alter table session add constraint session_id_club_id_key unique (id, club_id);
alter table product add constraint product_id_club_id_key unique (id, club_id);
alter table purchase add constraint purchase_id_club_id_key unique (id, club_id);

alter table attendance_record
  add constraint attendance_record_person_club_fkey
  foreign key (person_id, club_id) references person (id, club_id);

alter table attendance_record
  add constraint attendance_record_session_club_fkey
  foreign key (session_id, club_id) references session (id, club_id);

alter table attendance_record
  add constraint attendance_record_waived_purchase_club_fkey
  foreign key (waived_by_purchase_id, club_id) references purchase (id, club_id);

alter table purchase
  add constraint purchase_person_club_fkey
  foreign key (person_id, club_id) references person (id, club_id);

alter table purchase
  add constraint purchase_product_club_fkey
  foreign key (product_id, club_id) references product (id, club_id);

alter table chase_email
  add constraint chase_email_person_club_fkey
  foreign key (person_id, club_id) references person (id, club_id);
```

Note: `purchase_upload` has no `club_id` column yet (that's Task 3) — its composite FK to `product` is added in Task 3, not here.

- [ ] **Step 4: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "add_same_club_foreign_keys"`. If the Supabase MCP tools aren't directly callable, load them first: `ToolSearch(query: "select:mcp__supabase__apply_migration,mcp__supabase__execute_sql")`.

Expected: succeeds without error — all current data is Judo-only, so every composite FK is trivially satisfiable. If it fails, STOP: that means some existing row already has a mismatched club_id between a parent and child table, which is a real data-integrity bug to investigate, not something to work around by loosening the constraint.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/same-club-fk.spec.ts`
Expected: PASS, both tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261102090000_add_same_club_foreign_keys.sql tests/integration/same-club-fk.spec.ts
git commit -m "feat(db): add same-club foreign key backstop (person/session/product/purchase)"
```

---

### Task 2: `product` uniqueness per-club + the upsert conflict-target fix

**Files:**
- Create: `supabase/migrations/20261102090100_product_unique_per_club.sql`
- Modify: `lib/purchase/interface.ts`
- Test: `tests/integration/ingest-purchases.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `product_id_club_id_key`.
- Produces: `product` unique on `(club_id, name)` instead of globally on `(name)`. `ingestPurchases`'s by-name product upsert changes its `onConflict` target to `"club_id,name"` and now stamps `club_id` on the upserted row — in the SAME commit as the migration, since the old `onConflict: 'name'` would otherwise fail outright the moment the old constraint is gone (Postgres requires `onConflict` to name an existing unique constraint exactly).

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/ingest-purchases.spec.ts` (reuse its existing `createPerson`/helper patterns in that file):

```ts
test("two different clubs can each have their own product with the same name", async () => {
  const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
  const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  const sharedName = `Shared Product ${crypto.randomUUID()}`;

  const judoRow = await ingestPurchases([
    {
      externalId: `ext-judo-${crypto.randomUUID()}`,
      personName: "Judo Buyer",
      memberType: "Student",
      productName: sharedName,
      purchasedAt: new Date(),
      source: "pluto_api",
    },
  ]);
  expect(judoRow.inserted).toBe(1);

  const { data: judoProduct } = await admin
    .from("product")
    .select("id, club_id")
    .eq("name", sharedName)
    .eq("club_id", judo!.id)
    .maybeSingle();
  expect(judoProduct).not.toBeNull();

  // The Taekwondo product with the identical name must be a DIFFERENT row,
  // not reuse Judo's -- this test can't actually trigger the Taekwondo path
  // yet (ingestPurchases is still Judo-only until Plan 2b-2), so this
  // assertion is a placeholder for that later conversion. For THIS task,
  // the real assertion is that the migration + onConflict fix didn't break
  // Judo's own by-name upsert, proven by judoRow.inserted === 1 above and by
  // this duplicate-call idempotency check:
  const judoRowAgain = await ingestPurchases([
    {
      externalId: `ext-judo-again-${crypto.randomUUID()}`,
      personName: "Judo Buyer 2",
      memberType: "Student",
      productName: sharedName,
      purchasedAt: new Date(),
      source: "pluto_api",
    },
  ]);
  expect(judoRowAgain.inserted).toBe(1);
  const { data: stillOneProduct } = await admin.from("product").select("id").eq("name", sharedName);
  expect(stillOneProduct).toHaveLength(1);

  await admin.from("purchase").delete().eq("product_id", judoProduct!.id);
  await admin.from("product").delete().eq("id", judoProduct!.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/ingest-purchases.spec.ts`
Expected: the new test currently PASSES against the old global-unique schema (the by-name upsert already works for one club), which is fine — the real RED/GREEN cycle for this task is Step 4 below, where the migration temporarily breaks the OLD `onConflict: 'name'` call before Step 5's code fix lands. Run the file now just to confirm the new test passes against the current schema as a baseline.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261102090100_product_unique_per_club.sql
alter table product drop constraint product_name_unique;
alter table product add constraint product_club_id_name_key unique (club_id, name);
```

- [ ] **Step 4: Apply the migration, then immediately fix the code (do not skip ahead — apply and fix in the same task before moving on)**

Apply via `mcp__supabase__apply_migration` with `name: "product_unique_per_club"`.

In `lib/purchase/interface.ts`, find the by-name product upsert (currently `.from('product').upsert({ name: productName, kind: 'other' }, { onConflict: 'name', ignoreDuplicates: true })`) and change it to:

```ts
.from('product')
.upsert({ club_id: clubId, name: productName, kind: 'other' }, { onConflict: 'club_id,name', ignoreDuplicates: true })
```

Note: `clubId` here is the SAME `getDefaultClubId(admin)`-resolved value this file already uses elsewhere (per the Plan 1 hotfix, still in effect) — do not introduce a new resolution mechanism, reuse the existing local variable already in scope at this call site.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/ingest-purchases.spec.ts`
Expected: PASS, including the new test and every pre-existing test in this file (run the whole file, not just the new test, since this touches a shared code path).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261102090100_product_unique_per_club.sql lib/purchase/interface.ts tests/integration/ingest-purchases.spec.ts
git commit -m "feat(db): make product uniqueness per-club, fix the by-name upsert conflict target"
```

---

### Task 3: `purchase_upload` gains `club_id`

**Files:**
- Create: `supabase/migrations/20261102090200_add_club_id_to_purchase_upload.sql`
- Modify: `lib/xlsx/uploader.ts`
- Test: `tests/integration/purchase-upload.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `product_id_club_id_key`.
- Produces: `purchase_upload.club_id`, backfilled from its `product.club_id`, then set NOT NULL, with a same-club FK to `product`. `uploadXlsx`'s insert into `purchase_upload` stamps `club_id` in the SAME commit as the migration — this is exactly the Plan 1 incident shape (new NOT NULL column, existing insert that doesn't supply it) if done in two steps instead of one.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/purchase-upload.spec.ts`:

```ts
test("a purchase_upload row has club_id stamped matching its product's club", async () => {
  const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
  const product = await admin
    .from("product")
    .insert({ club_id: judo!.id, name: `Upload Test Product ${crypto.randomUUID()}`, kind: "other" })
    .select("id")
    .single();

  const { data: upload, error } = await admin
    .from("purchase_upload")
    .insert({ club_id: judo!.id, product_id: product.data!.id, row_count: 1, uploaded_by: "test@example.test" })
    .select("id, club_id")
    .single();
  expect(error).toBeNull();
  expect(upload!.club_id).toBe(judo!.id);

  await admin.from("purchase_upload").delete().eq("id", upload!.id);
  await admin.from("product").delete().eq("id", product.data!.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-upload.spec.ts`
Expected: FAIL — `club_id` doesn't exist as a column on `purchase_upload` yet, so the insert errors with something like `column purchase_upload.club_id does not exist`. Confirm the failure is specifically this missing-column error, not some other failure.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261102090200_add_club_id_to_purchase_upload.sql
alter table purchase_upload add column club_id uuid references club(id);

update purchase_upload pu
set club_id = p.club_id
from product p
where p.id = pu.product_id
and pu.club_id is null;

alter table purchase_upload alter column club_id set not null;

alter table purchase_upload
  add constraint purchase_upload_product_club_fkey
  foreign key (product_id, club_id) references product (id, club_id);
```

- [ ] **Step 4: Apply the migration, then immediately fix the code**

Apply via `mcp__supabase__apply_migration` with `name: "add_club_id_to_purchase_upload"`. Before applying, capture the current row count (`select count(*) from purchase_upload`) and confirm it matches after (same reasoning as Plan 1's backfill verification — a live table, don't trust a stale count).

In `lib/xlsx/uploader.ts`, find the `purchase_upload` insert (currently `.from("purchase_upload").insert({ product_id: product.id, filename: file.name, row_count: rows.length, uploaded_by: adminUser.email })`) and add `club_id`:

```ts
.from("purchase_upload")
.insert({
  club_id: clubId,
  product_id: product.id,
  filename: file.name,
  row_count: rows.length,
  uploaded_by: adminUser.email,
})
```

Resolve `clubId` the same way the rest of this file already does (via `getDefaultClubId(admin)`, the Plan 1 hotfix) — add that call near the top of `uploadXlsx` if it isn't already resolved there, reusing the existing import from `@/lib/supabase/default-club` already used elsewhere in this file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-upload.spec.ts`
Expected: PASS, including the new test and every pre-existing test in this file.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261102090200_add_club_id_to_purchase_upload.sql lib/xlsx/uploader.ts tests/integration/purchase-upload.spec.ts
git commit -m "feat(db): add club_id to purchase_upload, backfilled and NOT NULL"
```

---

### Task 4: `toggle_attendance` derives its club from the session (not hardcoded)

**Files:**
- Create: `supabase/migrations/20261102090300_toggle_attendance_derive_club.sql`
- Test: `tests/integration/toggle-attendance-club.spec.ts`

**Interfaces:**
- Consumes: nothing new — `session.club_id` already exists.
- Produces: `toggle_attendance(target_person_id, target_session_id, target_attended)` — same signature, no caller changes needed anywhere — now resolves `club_id` from `target_session_id`'s own `session.club_id` instead of the Plan 1 hotfix migration's hardcoded `(select id from club where slug = 'judo')`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/toggle-attendance-club.spec.ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

test.describe("toggle_attendance derives club from session", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) {
      await admin.from("attendance_record").delete().in("person_id", personIds);
      await admin.from("person").delete().in("id", personIds);
    }
    if (sessionIds.length) await admin.from("session").delete().in("id", sessionIds);
    personIds = [];
    sessionIds = [];
  });

  test("toggling attendance for a Taekwondo session stamps the Taekwondo club_id, not Judo's", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();

    const person = await admin
      .from("person")
      .insert({
        club_id: taekwondo!.id,
        full_name: "Taekwondo Person",
        email: `tkd-toggle-${crypto.randomUUID()}@example.test`,
      })
      .select("id")
      .single();
    personIds.push(person.data!.id);

    const session = await admin
      .from("session")
      .insert({ club_id: taekwondo!.id, title: "Taekwondo Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    sessionIds.push(session.data!.id);

    const { error } = await admin.rpc("toggle_attendance", {
      target_person_id: person.data!.id,
      target_session_id: session.data!.id,
      target_attended: true,
    });
    expect(error).toBeNull();

    const { data: record } = await admin
      .from("attendance_record")
      .select("club_id")
      .eq("person_id", person.data!.id)
      .eq("session_id", session.data!.id)
      .single();
    expect(record!.club_id).toBe(taekwondo!.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/toggle-attendance-club.spec.ts`
Expected: FAIL — with the current hardcoded-Judo migration, this either errors with a foreign-key violation (since Task 1's same-club FK now rejects `club_id = judo` paired with a Taekwondo person/session) or, if Task 1 hasn't run yet, silently stamps the wrong club. Either way, `record!.club_id` will not equal `taekwondo!.id`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261102090300_toggle_attendance_derive_club.sql
create or replace function public.toggle_attendance(
  target_person_id uuid,
  target_session_id uuid,
  target_attended boolean
)
returns void
language sql
set search_path to 'public'
as $function$
  insert into public.attendance_record (club_id, person_id, session_id, attended, source, recorded_at)
  values (
    (select club_id from public.session where id = target_session_id),
    target_person_id,
    target_session_id,
    target_attended,
    'manual_tick',
    now()
  )
  on conflict (person_id, session_id)
  do update set attended = excluded.attended, recorded_at = excluded.recorded_at;
$function$;
```

- [ ] **Step 4: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "toggle_attendance_derive_club"`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/toggle-attendance-club.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run the existing attendance-toggle suite to confirm Judo still works**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/attendance-toggle.spec.ts`
Expected: PASS, unchanged — this function's signature didn't change, only its internal club resolution, so every existing caller is unaffected.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261102090300_toggle_attendance_derive_club.sql tests/integration/toggle-attendance-club.spec.ts
git commit -m "feat(db): toggle_attendance derives club_id from the session, not a hardcoded slug"
```

---

### Task 5: `search_person_by_name` requires a club id + `searchPeople`'s caller fix

**Files:**
- Create: `supabase/migrations/20261102090400_search_person_by_name_club_scoped.sql`
- Modify: `lib/attendance/actions.ts`
- Test: `tests/integration/person-search.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 1's schema (not directly, but this task's migration depends on nothing from Tasks 1-4 structurally — it's independent, just sequenced here for plan clarity).
- Produces: `search_person_by_name(target_club_id uuid, search_query text, match_limit int default 8)` — a required new first parameter, breaking the old 2-arg signature. `searchPeople` in `lib/attendance/actions.ts` (already takes `clubSlug` as its first parameter per Plan 2a) resolves `clubId` via `requireAdmin(clubSlug)` (already does this) and passes it to the RPC — in the SAME commit as the migration, since the old 2-arg call would fail outright the moment the old signature is dropped.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/person-search.spec.ts`:

```ts
test("a Taekwondo person is not found when searching as Judo", async () => {
  const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
  const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  const uniqueName = `Zzyxqvw Tkdperson ${crypto.randomUUID().slice(0, 8)}`;

  const tkdPerson = await admin
    .from("person")
    .insert({ club_id: taekwondo!.id, full_name: uniqueName, email: `tkd-search-${crypto.randomUUID()}@example.test` })
    .select("id")
    .single();

  const { data: resultsAsJudo, error } = await admin.rpc("search_person_by_name", {
    target_club_id: judo!.id,
    search_query: uniqueName,
    match_limit: 8,
  });
  expect(error).toBeNull();
  expect((resultsAsJudo ?? []).map((r: { id: string }) => r.id)).not.toContain(tkdPerson.data!.id);

  const { data: resultsAsTaekwondo } = await admin.rpc("search_person_by_name", {
    target_club_id: taekwondo!.id,
    search_query: uniqueName,
    match_limit: 8,
  });
  expect((resultsAsTaekwondo ?? []).map((r: { id: string }) => r.id)).toContain(tkdPerson.data!.id);

  await admin.from("person").delete().eq("id", tkdPerson.data!.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/person-search.spec.ts`
Expected: FAIL — calling the current 2-arg function with a `target_club_id` key in the args object either errors (unknown parameter) or, if Postgres ignores extra keys, the Taekwondo person would be found when searching "as Judo" since there's no club filter at all yet.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261102090400_search_person_by_name_club_scoped.sql
drop function public.search_person_by_name(text, int);

create function public.search_person_by_name(target_club_id uuid, search_query text, match_limit int default 8)
returns table (id uuid, full_name text, email text, cid text, similarity real)
language sql stable
set search_path to 'public'
as $function$
  select
    id,
    full_name,
    email,
    cid,
    greatest(
      similarity(full_name, search_query),
      (case when email ilike '%' || search_query || '%' then 1 else 0 end)::real
    ) as similarity
  from public.person
  where club_id = target_club_id
    and (full_name % search_query or email ilike '%' || search_query || '%')
  order by similarity desc
  limit match_limit;
$function$;

grant execute on function public.search_person_by_name(uuid, text, int) to authenticated, anon, service_role;
```

(Preserving the exact same grants as the current live function — `authenticated`, `anon`, `service_role` — confirmed via a live grants query before writing this migration.)

- [ ] **Step 4: Apply the migration, then immediately fix the caller**

Apply via `mcp__supabase__apply_migration` with `name: "search_person_by_name_club_scoped"`.

In `lib/attendance/actions.ts`, find `searchPeople`'s call to the RPC (currently something like `admin.rpc("search_person_by_name", { search_query: query, match_limit: 8 })`) and add the club argument, using the `clubId` already returned by this function's existing `requireAdmin(clubSlug)` call:

```ts
export async function searchPeople(clubSlug: string, query: string): Promise<PersonSearchResult[]> {
  const { clubId } = await requireAdmin(clubSlug);
  // ...existing input validation unchanged...
  const { data, error } = await admin.rpc("search_person_by_name", {
    target_club_id: clubId,
    search_query: query,
    match_limit: 8,
  });
  // ...existing result mapping unchanged...
}
```

Read the function's actual current body first — only add the `target_club_id: clubId` key to the existing RPC call's args object, don't rewrite anything else.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/person-search.spec.ts`
Expected: PASS, including the new test and every pre-existing test in this file.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261102090400_search_person_by_name_club_scoped.sql lib/attendance/actions.ts tests/integration/person-search.spec.ts
git commit -m "feat(db): scope search_person_by_name by club, fix searchPeople's caller"
```

---

### Task 6: `outstanding_attendance` and `active_debt_cycle` views gain `club_id`

**Files:**
- Create: `supabase/migrations/20261102090500_debt_views_add_club_id.sql`
- Test: `tests/integration/debt-views-club-id.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: both views gain a trailing `club_id` column via `create or replace view` (no drop, no caller breaks — every existing consumer that selects specific columns or `*` keeps working; a consumer selecting `*` just gets one more column, which no existing caller treats as an error).

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/debt-views-club-id.spec.ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

test.describe("debt views expose club_id", () => {
  test("outstanding_attendance rows have a club_id column", async () => {
    const { data, error } = await admin.from("outstanding_attendance").select("club_id").limit(1);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  test("active_debt_cycle rows have a club_id column", async () => {
    const { data, error } = await admin.from("active_debt_cycle").select("club_id").limit(1);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/debt-views-club-id.spec.ts`
Expected: FAIL — `column outstanding_attendance.club_id does not exist` (and same for `active_debt_cycle`).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261102090500_debt_views_add_club_id.sql
create or replace view public.outstanding_attendance as
select
  ar.id,
  ar.person_id,
  ar.session_id,
  s.starts_at,
  ar.club_id
from attendance_record ar
join session s on s.id = ar.session_id
where ar.waived_by_purchase_id is null
  and ar.attended
  and ar.id <> (
    select ar2.id
    from attendance_record ar2
    join session s2 on s2.id = ar2.session_id
    where ar2.person_id = ar.person_id and ar2.attended
    order by s2.starts_at, ar2.id
    limit 1
  )
  and not exists (
    select 1
    from purchase p
    join product pr on pr.id = p.product_id
    where p.person_id = ar.person_id
      and pr.kind = any (array['term_pass', 'annual_pass'])
      and s.starts_at >= p.purchased_at
      and (
        (pr.covers_until is not null and s.starts_at < pr.covers_until)
        or (pr.covers_until is null and pr.covers_days is not null and s.starts_at < p.purchased_at + (pr.covers_days || ' days')::interval)
      )
  );

create or replace view public.active_debt_cycle as
select
  p.id as person_id,
  p.full_name,
  p.email,
  min(oa.starts_at) as debt_cycle_started_at,
  count(*) as debt_count,
  p.club_id
from outstanding_attendance oa
join person p on p.id = oa.person_id
where not p.is_exempt
group by p.id, p.full_name, p.email, p.club_id;
```

This is the exact current live definition of both views (fetched directly before writing this migration), with only `ar.club_id` / `p.club_id` appended as a trailing column and `p.club_id` added to `active_debt_cycle`'s `GROUP BY` (required since it's now a selected non-aggregate column) — no other logic changed.

- [ ] **Step 4: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "debt_views_add_club_id"`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/debt-views-club-id.spec.ts`
Expected: PASS, both tests.

- [ ] **Step 6: Run the existing debt-calculation suite to confirm nothing broke**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/debt-calculation.spec.ts`
Expected: PASS, unchanged — these views' existing columns and row-selection logic are untouched.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261102090500_debt_views_add_club_id.sql tests/integration/debt-views-club-id.spec.ts
git commit -m "feat(db): add club_id column to outstanding_attendance and active_debt_cycle views"
```

---

### Task 7: `reapply_waivers_for_everyone_with_debt` requires a club id + its caller fix

**Files:**
- Create: `supabase/migrations/20261102090600_reapply_waivers_club_scoped.sql`
- Modify: `lib/purchase/interface.ts`
- Modify: `app/api/cron/chase-emails/route.ts`
- Test: `tests/integration/purchase-waivers.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 6's `active_debt_cycle.club_id`.
- Produces: `reapply_waivers_for_everyone_with_debt(target_club_id uuid)` — a required new parameter, breaking the old 0-arg signature. `reapplyWaiversForEveryoneWithDebt` in `lib/purchase/interface.ts` and its caller in the weekly chase-emails cron route both pass `clubId` (resolved via the existing `getDefaultClubId(admin)` hotfix helper, same as every other not-yet-converted call site) — in the SAME commit as the migration.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/purchase-waivers.spec.ts`:

```ts
test("reapplyWaiversForEveryoneWithDebt only processes the target club's debtors", async () => {
  const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
  const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();

  // A Taekwondo debtor: one attendance record, unwaived, no pass.
  const tkdPerson = await admin
    .from("person")
    .insert({ club_id: taekwondo!.id, full_name: "TKD Debtor", email: `tkd-debt-${crypto.randomUUID()}@example.test` })
    .select("id")
    .single();
  const tkdSession1 = await admin
    .from("session")
    .insert({ club_id: taekwondo!.id, title: "TKD S1", starts_at: new Date(Date.now() - 20 * 86400000).toISOString() })
    .select("id")
    .single();
  const tkdSession2 = await admin
    .from("session")
    .insert({ club_id: taekwondo!.id, title: "TKD S2", starts_at: new Date(Date.now() - 10 * 86400000).toISOString() })
    .select("id")
    .single();
  await admin.from("attendance_record").insert([
    { club_id: taekwondo!.id, person_id: tkdPerson.data!.id, session_id: tkdSession1.data!.id, source: "manual_tick" },
    { club_id: taekwondo!.id, person_id: tkdPerson.data!.id, session_id: tkdSession2.data!.id, source: "manual_tick" },
  ]);

  const { data: resultForJudo, error } = await admin.rpc("reapply_waivers_for_everyone_with_debt", {
    target_club_id: judo!.id,
  });
  expect(error).toBeNull();
  expect((resultForJudo ?? []).map((r: { person_id: string }) => r.person_id)).not.toContain(tkdPerson.data!.id);

  await admin.from("attendance_record").delete().eq("person_id", tkdPerson.data!.id);
  await admin.from("session").delete().in("id", [tkdSession1.data!.id, tkdSession2.data!.id]);
  await admin.from("person").delete().eq("id", tkdPerson.data!.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-waivers.spec.ts`
Expected: FAIL — calling the current 0-arg function with a `target_club_id` key either errors (function does not exist with this signature) or, if you call it with no args as today, it processes every club's debtors including the Taekwondo one just inserted, so filtering "did it touch the Taekwondo person" would show it did.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261102090600_reapply_waivers_club_scoped.sql
drop function public.reapply_waivers_for_everyone_with_debt();

create function public.reapply_waivers_for_everyone_with_debt(target_club_id uuid)
returns table(person_id uuid, waived int)
language plpgsql
set search_path to 'public'
as $function$
declare
  v_person_id uuid;
begin
  if target_club_id is null then
    raise exception 'target_club_id is required';
  end if;
  for v_person_id in
    select adc.person_id from public.active_debt_cycle adc where adc.club_id = target_club_id
  loop
    person_id := v_person_id;
    waived := public.reapply_waivers_for_person(v_person_id);
    return next;
  end loop;
  return;
end;
$function$;

grant execute on function public.reapply_waivers_for_everyone_with_debt(uuid) to service_role;
```

(Preserving the exact same grant as the current live function — `service_role` only.)

- [ ] **Step 4: Apply the migration, then immediately fix both callers**

Apply via `mcp__supabase__apply_migration` with `name: "reapply_waivers_club_scoped"`.

In `lib/purchase/interface.ts`, find `reapplyWaiversForEveryoneWithDebt` (currently calls the RPC with no args) and update it to resolve and pass `clubId`:

```ts
export async function reapplyWaiversForEveryoneWithDebt(): Promise<ReapplySweepResult> {
  const admin = createAdminClient();
  const clubId = await getDefaultClubId(admin);
  const { data, error } = await admin.rpc("reapply_waivers_for_everyone_with_debt", { target_club_id: clubId });
  // ...existing result mapping unchanged...
}
```

Read the function's actual current body first — only add the `clubId` resolution and the `target_club_id` argument, don't change the result-mapping logic. `getDefaultClubId` should already be imported in this file (it's used by other functions here per the Plan 1 hotfix) — reuse that import, don't add a new one.

In `app/api/cron/chase-emails/route.ts`, confirm its call to `reapplyWaiversForEveryoneWithDebt()` needs no change (the function's own exported signature doesn't change — it still takes no arguments from the outside, it just internally resolves `clubId` now). If this route's code looks different from that expectation when you read it, stop and report NEEDS_CONTEXT rather than guessing.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-waivers.spec.ts`
Expected: PASS, including the new test and every pre-existing test in this file.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261102090600_reapply_waivers_club_scoped.sql lib/purchase/interface.ts tests/integration/purchase-waivers.spec.ts
git commit -m "feat(db): scope reapply_waivers_for_everyone_with_debt by club, fix its caller"
```

---

### Task 8: Full regression pass

**Files:**
- None created or modified — this task only runs the existing suites to confirm all 7 prior tasks together haven't broken anything.

- [ ] **Step 1: Run the full e2e suite**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts tests/e2e/login-redirect.spec.ts`
Expected: PASS, unchanged — this plan touches no routing/auth code.

- [ ] **Step 2: Run the full integration suite**

Run: `npx playwright test --config=playwright.integration.config.ts`
Expected: PASS, every test in every file — the 7 migrations plus their caller fixes together, with no file left in a partially-converted state.

- [ ] **Step 3: Confirm the app still compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Record completion**

No commit needed — this task is verification-only. If anything fails, stop and treat it as a regression introduced by Tasks 1-7, not something to patch around in this task.

---

### Task 9 (added mid-execution — ruling, see ledger): Fix `club-scoped-client.spec.ts`'s now-invalid `product` conflict target

**Why this task exists:** Task 8 found `tests/integration/club-scoped-client.spec.ts`'s "upsert with onConflict missing club_id does NOT throw when ignoreDuplicates is true" test failing with Postgres error 42P10 ("no unique or exclusion constraint matching the ON CONFLICT specification"). This is not a defect in Tasks 1-7 — it's a cross-plan interaction: that test was written in the previous plan (Plan 2a), when `product` still had a global `unique(name)` constraint, and used `onConflict: "name"` against `product` as its illustrative example of a conflict target lacking `club_id`. Task 2 of THIS plan correctly moved `product` to `unique(club_id, name)`, so `onConflict: "name"` is no longer a real constraint Postgres can match — the test's second half (the actual DB round-trip) now fails for a reason unrelated to the guard logic it was testing.

**Files:**
- Modify: `tests/integration/club-scoped-client.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the test's first half (the synchronous JS-guard check, which never reaches Postgres since `.upsert()` is lazily awaited) keeps `onConflict: "name"` — this still correctly demonstrates the guard permitting a bypass via `ignoreDuplicates` for a conflict target string that omits `club_id`, with zero database dependency. The test's second half (the actual awaited round-trip, which must match a real constraint) changes to `onConflict: "club_id,name"` — the realistic, now-correct usage pattern for this table, matching exactly what Task 2 already did for the real `ingestPurchases` product upsert.

- [ ] **Step 1: Confirm the failure matches this diagnosis**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/club-scoped-client.spec.ts`
Expected: FAIL, specifically the "does NOT throw when ignoreDuplicates is true" test, with a Postgres `42P10` error on the awaited upsert call — not a failure of the `expect(() => ...).not.toThrow()` synchronous assertion above it (that one has no DB dependency and should still pass). If the failure doesn't match this exact shape, stop and report NEEDS_CONTEXT rather than applying the fix below blindly.

- [ ] **Step 2: Fix the test**

In `tests/integration/club-scoped-client.spec.ts`, change only the awaited round-trip's `onConflict` value (leave the synchronous `expect(() => ...).not.toThrow()` call above it unchanged):

```ts
const { data, error } = await scoped
  .from("product")
  .upsert({ name, kind: "other" }, { onConflict: "club_id,name", ignoreDuplicates: true })
  .select("id");
expect(error).toBeNull();
```

- [ ] **Step 3: Run the test file to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/club-scoped-client.spec.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 4: Re-run the full regression pass**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts tests/e2e/login-redirect.spec.ts`, then `npx playwright test --config=playwright.integration.config.ts`, then `npx tsc --noEmit`.
Expected: all PASS — this is Task 8's checklist, re-run in full now that the one failure is fixed.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/club-scoped-client.spec.ts
git commit -m "test: fix club-scoped-client's product onConflict target after Task 2's per-club uniqueness change"
```
