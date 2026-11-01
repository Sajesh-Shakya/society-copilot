# Multi-Tenancy Plan 2a: Club-Aware Routing and Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every admin request a real, verified `clubId` — via path-based routing (`/club/[clubSlug]/...`), a `requireAdmin(clubSlug)` that resolves it, and a `createClubScopedClient(clubId)` guardrail — without yet converting any business-logic query to use it (that's Plan 2b).

**Architecture:** `requireAdmin(clubSlug)` resolves the club and checks the new `admin` table in one call, returning `{email, clubId, clubName}`. Every page moves under `app/club/[clubSlug]/...` and calls it; every Server Action it calls takes `clubSlug` as its first argument and re-derives `clubId` itself (never trusts a client-supplied `clubId`, which would skip the admin check). `createClubScopedClient(clubId)` is built and tested here but not yet wired into existing business logic — Plan 2b's job. `admin_allowlist` stays untouched as a rollback path for one release.

**Tech Stack:** Next.js App Router (Server Actions, middleware), Supabase (Postgres, Auth), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-multi-tenancy-plan2-design.md`

## Global Constraints

- No business-logic query in `lib/attendance`, `lib/purchase`, `lib/chase`, `lib/csv-import`, `lib/person` gets converted to club-scoping in this plan — only its Server Action entry point gains a `clubSlug` parameter and calls `requireAdmin(clubSlug)`. The query itself still runs through the existing `createAdminClient()` / the hotfix's `getDefaultClubId()`, exactly as today.
- Never accept a raw `clubId` from a client component or form field — only a `clubSlug`, re-verified by `requireAdmin(clubSlug)` server-side on every call.
- `requireAdmin`'s unauthorized error message must be byte-identical whether the club slug doesn't exist or the signed-in email isn't an admin of it — never let the error reveal which club slugs are valid.
- `admin_allowlist` is not dropped, not modified structurally. `scripts/create-admin.ts` keeps writing to it alongside the new `admin` table.
- No Taekwondo `admin` row gets created as part of this plan or its testing — only Judo admins exist until Plan 2b's cross-tenant tests pass.
- `app/api/sessions/[sessionId]/sync/route.ts` is explicitly **out of scope** for this plan — it requires no changes. It's machine-authenticated (`SYNC_TRIGGER_SECRET`), not admin-session-gated, and stays exactly where it is; deriving its club from `session.club_id` only becomes meaningful once `syncSessionAttendance` itself is club-aware, which is Plan 2b's job. Do not move it under `/api/club/[clubSlug]/...` and do not add any club check to it in this plan.
- **`requireAdmin(clubSlug)` takes `clubSlug` as an OPTIONAL parameter with a transitional default of `"judo"`, not a required one, until Task 9.** Tasks 6 and 7 are the only two tasks that convert every existing caller to pass `clubSlug` explicitly, and they can't both happen in the same commit as Task 1. If `clubSlug` were required from Task 1 onward, every unconverted caller (every page and Server Action Tasks 6–7 haven't reached yet) would fail to compile for the entire span between Task 1 and Task 7 — a broken intermediate state that none of this plan's task-level test commands (which run specific test files, not a full build) would catch. The default keeps every unconverted call site working exactly as it does today (functionally identical to the existing hotfix's Judo-only behavior) until Task 9 removes the default once Tasks 6–7 have converted everything.

## Review Focus

- **A signed-in Judo admin visiting `/club/taekwondo/sessions` must be refused**, not silently shown Judo's data under a Taekwondo-looking URL — this is the entire point of the plan, and the easiest way to get it subtly wrong (e.g. forgetting to re-check `clubSlug` inside a Server Action rather than just the page). `requireAdmin()` itself can't be driven end-to-end in these tests (it needs a real authenticated session), so this is pinned at its actual enforcement logic: Task 1's `checkAdminForClub` tests prove a Judo-only admin is rejected for `taekwondo` and accepted for `judo`.
- **An admin of two clubs who gets redirected to `/select-club` must not be able to skip it** by navigating straight to a club URL they don't administer — `requireAdmin(clubSlug)` (built on the same `checkAdminForClub` proven in Task 1) is the real gate regardless of how the user arrived at the URL; every page's own `requireAdmin(clubSlug)` call is what actually enforces this, not the picker page's existence.
- **A Server Action invoked with a `clubSlug` that doesn't match the signed-in admin's actual club membership must throw**, not silently proceed with whatever `clubId` happens to resolve — same `checkAdminForClub` guarantee from Task 1, which every Server Action touched in Tasks 6–7 now calls via `requireAdmin(clubSlug)` as its first line.
- **`createClubScopedClient`'s insert/update must reject a payload that tries to set a different `club_id`**, not silently overwrite it — a caller passing the wrong value by mistake should get a loud error, not quiet data drift. Pinned in Task 2.
- **The post-sign-in redirect must handle exactly 0, exactly 1, and more-than-1 admin club memberships correctly** — the 0-club case (an email signed in but not an admin anywhere) is easy to forget since today every signed-in user is implicitly a Judo admin. Pinned in Task 5.

---

### Task 1: `requireAdmin(clubSlug)`, `listAdminClubs`, and the `clubPath` helper

**Files:**
- Modify: `lib/auth/require-admin.ts`
- Create: `lib/club-path.ts`
- Test: `tests/integration/require-admin.spec.ts` (new)

**Interfaces:**
- Produces: `requireAdmin(clubSlug: string): Promise<{ email: string; clubId: string; clubName: string }>`, `checkAdminForClub(email: string, clubSlug: string): Promise<{ clubId: string; clubName: string }>` (the testable half of `requireAdmin` — the part that doesn't depend on a real authenticated session), `listAdminClubs(email: string): Promise<{ clubId: string; slug: string; name: string }[]>`, `clubPath(clubSlug: string, path: string): string`. Every later task in this plan calls `requireAdmin`/`listAdminClubs`/`clubPath`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/require-admin.spec.ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminClubs } from "@/lib/auth/require-admin";

const admin = createAdminClient();

test.describe("listAdminClubs", () => {
  test("returns every club an email administers, with slug and name", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const email = `list-admin-clubs-${crypto.randomUUID()}@example.test`;
    await admin.from("admin").insert({ email, club_id: judo!.id });

    const clubs = await listAdminClubs(email);
    expect(clubs).toEqual([{ clubId: judo!.id, slug: "judo", name: "Judo" }]);

    await admin.from("admin").delete().eq("email", email);
  });

  test("returns an empty array for an email with no admin rows", async () => {
    const clubs = await listAdminClubs(`nobody-${crypto.randomUUID()}@example.test`);
    expect(clubs).toEqual([]);
  });

  test("returns multiple clubs for an email administering more than one", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const { data: tkd } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const email = `multi-club-${crypto.randomUUID()}@example.test`;
    await admin.from("admin").insert([
      { email, club_id: judo!.id },
      { email, club_id: tkd!.id },
    ]);

    const clubs = await listAdminClubs(email);
    expect(clubs.map((c) => c.slug).sort()).toEqual(["judo", "taekwondo"]);

    await admin.from("admin").delete().eq("email", email);
  });
});
```

```ts
// tests/unit/club-path.spec.ts
import { test, expect } from "@playwright/test";
import { clubPath } from "@/lib/club-path";

test("clubPath joins a club slug and a path, normalizing a missing leading slash", () => {
  expect(clubPath("judo", "/sessions")).toBe("/club/judo/sessions");
  expect(clubPath("judo", "sessions")).toBe("/club/judo/sessions");
  expect(clubPath("judo", "/sessions/new")).toBe("/club/judo/sessions/new");
});
```

```ts
// append to tests/integration/require-admin.spec.ts — this is the test that
// actually pins Review Focus item 1 ("a Judo admin must be refused on
// Taekwondo's URL"). requireAdmin() itself can't be unit-tested directly
// (it depends on a real authenticated request's cookies via
// lib/supabase/server.ts), so checkAdminForClub is the testable half that
// requireAdmin calls after resolving the signed-in user's email.
import { checkAdminForClub, UnauthorizedError } from "@/lib/auth/require-admin";

test.describe("checkAdminForClub", () => {
  test("rejects an admin of a different club", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const email = `cross-club-${crypto.randomUUID()}@example.test`;
    await admin.from("admin").insert({ email, club_id: judo!.id });

    await expect(checkAdminForClub(email, "taekwondo")).rejects.toThrow("Not authorized for this club.");
    await expect(checkAdminForClub(email, "judo")).resolves.toMatchObject({ clubId: judo!.id });

    await admin.from("admin").delete().eq("email", email);
  });

  test("gives the identical error for an unknown club slug and a known club the email doesn't administer", async () => {
    const email = `no-admin-${crypto.randomUUID()}@example.test`;
    let unknownClubMessage: string | undefined;
    let notAdminMessage: string | undefined;
    try {
      await checkAdminForClub(email, `unknown-${crypto.randomUUID()}`);
    } catch (e) {
      unknownClubMessage = (e as Error).message;
    }
    try {
      await checkAdminForClub(email, "judo");
    } catch (e) {
      notAdminMessage = (e as Error).message;
    }
    expect(unknownClubMessage).toBeDefined();
    expect(unknownClubMessage).toBe(notAdminMessage);
  });

  test("rejects with UnauthorizedError, not a bare Error", async () => {
    await expect(checkAdminForClub(`nobody-${crypto.randomUUID()}@example.test`, "judo")).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/require-admin.spec.ts` and `npx playwright test tests/unit/club-path.spec.ts`
Expected: FAIL — `listAdminClubs` and `clubPath` don't exist yet.

- [ ] **Step 3: Write `lib/club-path.ts`**

```ts
export function clubPath(clubSlug: string, path: string): string {
  return `/club/${clubSlug}${path.startsWith("/") ? path : `/${path}`}`;
}
```

- [ ] **Step 4: Rewrite `lib/auth/require-admin.ts`**

```ts
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export class UnauthorizedError extends Error {}

const NOT_AUTHORIZED_MESSAGE = "Not authorized for this club.";

/**
 * The club-membership check, factored out from requireAdmin so it's
 * directly testable without a real authenticated request (requireAdmin
 * itself depends on lib/supabase/server.ts's cookie-based session, which
 * integration tests can't easily fake). Returns the identical
 * NOT_AUTHORIZED_MESSAGE whether clubSlug doesn't exist or the given email
 * just isn't an admin of it -- the error must never reveal which club
 * slugs are valid.
 */
export async function checkAdminForClub(
  email: string,
  clubSlug: string
): Promise<{ clubId: string; clubName: string }> {
  const admin = createAdminClient();

  const { data: club, error: clubError } = await admin
    .from("club")
    .select("id, name")
    .eq("slug", clubSlug)
    .maybeSingle();
  if (clubError) throw clubError;
  if (!club) throw new UnauthorizedError(NOT_AUTHORIZED_MESSAGE);

  const { data: row, error: adminError } = await admin
    .from("admin")
    .select("email")
    .eq("email", email.toLowerCase())
    .eq("club_id", club.id)
    .maybeSingle();
  if (adminError) throw adminError;
  if (!row) throw new UnauthorizedError(NOT_AUTHORIZED_MESSAGE);

  return { clubId: club.id, clubName: club.name };
}

// Transitional default -- DELETE this default (and this comment) in Task 9,
// once Tasks 6-7 have converted every caller to pass clubSlug explicitly.
// Without it, every not-yet-converted caller would fail to compile the
// moment this task lands, for the entire span until Task 7 finishes.
const TRANSITIONAL_DEFAULT_CLUB_SLUG = "judo";

/**
 * The actual enforcement point for admin-only Server Actions and pages.
 * Re-checks club membership on every call, same as the pre-multi-tenancy
 * version re-checked admin_allowlist, so revoking access takes effect
 * immediately without invalidating the Supabase session.
 */
export async function requireAdmin(
  clubSlug: string = TRANSITIONAL_DEFAULT_CLUB_SLUG
): Promise<{ email: string; clubId: string; clubName: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    throw new UnauthorizedError("Not signed in");
  }

  const email = user.email.toLowerCase();
  const { clubId, clubName } = await checkAdminForClub(email, clubSlug);
  return { email, clubId, clubName };
}

/**
 * Every club a signed-in email administers -- used by the post-sign-in
 * redirect (lib/auth/actions.ts) and the multi-club picker (app/select-club).
 */
export async function listAdminClubs(
  email: string
): Promise<{ clubId: string; slug: string; name: string }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("admin")
    .select("club_id, club:club_id(slug, name)")
    .eq("email", email.toLowerCase());
  if (error) throw error;

  return (data ?? []).map((row) => {
    // supabase-js types a to-one FK select as an array; it's always exactly
    // one row here since club_id is not-null with a FK (same pattern as
    // lib/csv-import/importer.ts's person:person_id select).
    const club = Array.isArray(row.club) ? row.club[0] : row.club;
    return { clubId: row.club_id, slug: club.slug, name: club.name };
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/require-admin.spec.ts` and `npx playwright test tests/unit/club-path.spec.ts`
Expected: PASS, all 7 tests (4 from Step 1 + 3 `checkAdminForClub` tests appended above).

- [ ] **Step 6: Confirm the rest of the app still compiles**

Run: `npx tsc --noEmit`
Expected: no errors. Every existing `requireAdmin()` call site (none of which pass `clubSlug` yet) still compiles because of the `TRANSITIONAL_DEFAULT_CLUB_SLUG` default from Step 4 — if this fails, something other than `requireAdmin`'s signature changed unexpectedly.

- [ ] **Step 7: Commit**

```bash
git add lib/auth/require-admin.ts lib/club-path.ts tests/integration/require-admin.spec.ts tests/unit/club-path.spec.ts
git commit -m "feat(auth): requireAdmin(clubSlug), listAdminClubs, clubPath helper"
```

---

### Task 2: `createClubScopedClient(clubId)`

**Files:**
- Create: `lib/supabase/club-scoped.ts`
- Test: `tests/integration/club-scoped-client.spec.ts`

**Interfaces:**
- Consumes: `createAdminClient()` from `lib/supabase/admin.ts` (unchanged, reused as-is).
- Produces: `createClubScopedClient(clubId: string)` with `.from(table).select/insert/upsert/update/delete` and `.rpc(name, args)`. Not consumed by any other task in this plan — Plan 2b wires it into business logic. Built and tested now so 2b has no new abstraction to design mid-sweep.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/club-scoped-client.spec.ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("createClubScopedClient", () => {
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) await admin.from("person").delete().in("id", personIds);
    personIds = [];
  });

  test("select automatically filters by club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const email = `scoped-select-${crypto.randomUUID()}@example.test`;

    const inserted = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Judo Person", email })
      .select("id")
      .single();
    personIds.push(inserted.data!.id);

    const scopedAsTaekwondo = createClubScopedClient(taekwondo);
    const { data } = await scopedAsTaekwondo.from("person").select("id").eq("email", email);
    expect(data).toEqual([]);

    const scopedAsJudo = createClubScopedClient(judo);
    const { data: found } = await scopedAsJudo.from("person").select("id").eq("email", email);
    expect(found).toHaveLength(1);
  });

  test("insert stamps club_id automatically, without the caller supplying it", async () => {
    const judo = await clubId("judo");
    const scoped = createClubScopedClient(judo);
    const email = `scoped-insert-${crypto.randomUUID()}@example.test`;

    const { data, error } = await scoped
      .from("person")
      .insert({ full_name: "Stamped", email })
      .select("id")
      .single();
    expect(error).toBeNull();
    personIds.push(data!.id);

    const { data: row } = await admin.from("person").select("club_id").eq("id", data!.id).single();
    expect(row!.club_id).toBe(judo);
  });

  test("insert throws if the caller explicitly passes a different club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const scoped = createClubScopedClient(judo);

    // insert's club_id guard throws synchronously (it's a programmer-error
    // assertion, not a soft/awaitable failure -- see the design note in
    // club-scoped.ts), so this is a plain synchronous throw check, not
    // `.rejects`, which needs a Promise to attach to.
    expect(() =>
      scoped.from("person").insert({ club_id: taekwondo, full_name: "X", email: `x-${crypto.randomUUID()}@example.test` })
    ).toThrow();
  });

  test("update is scoped to the caller's club and cannot change club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const email = `scoped-update-${crypto.randomUUID()}@example.test`;

    const inserted = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Before", email })
      .select("id")
      .single();
    personIds.push(inserted.data!.id);

    // A Taekwondo-scoped client updating a Judo row's id affects zero rows.
    const scopedAsTaekwondo = createClubScopedClient(taekwondo);
    await scopedAsTaekwondo.from("person").update({ full_name: "Hacked" }).eq("id", inserted.data!.id);
    const { data: unchanged } = await admin.from("person").select("full_name").eq("id", inserted.data!.id).single();
    expect(unchanged!.full_name).toBe("Before");

    // Trying to move the row to another club is rejected outright. update's
    // club_id guard throws synchronously, before .eq() is ever reached, so
    // this is a plain synchronous throw check, not `.rejects`.
    const scopedAsJudo = createClubScopedClient(judo);
    expect(() => scopedAsJudo.from("person").update({ club_id: taekwondo })).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/club-scoped-client.spec.ts`
Expected: FAIL — `lib/supabase/club-scoped.ts` doesn't exist yet.

- [ ] **Step 3: Write `lib/supabase/club-scoped.ts`**

```ts
import { createAdminClient } from "@/lib/supabase/admin";

const CLUB_SCOPED_TABLES = [
  "person",
  "session",
  "product",
  "purchase",
  "purchase_upload",
  "attendance_record",
  "chase_email",
  "sync_cursor",
  "outstanding_attendance",
  "active_debt_cycle",
] as const;
type ClubScopedTable = (typeof CLUB_SCOPED_TABLES)[number];

// RPCs that read/write across the whole table and need the club baked into
// their own SQL (a post-hoc .eq() on the result can't scope a function that
// already LIMITs internally, or that writes as a side effect) -- see
// docs/superpowers/specs/2026-11-01-multi-tenancy-plan2-design.md's Migration
// C/D. Row-scoped RPCs (toggle_attendance, apply_purchase_waiver,
// reapply_waivers_for_person, person_outstanding_debt) are NOT in this list
// -- they pass through unchanged, relying on the caller having already
// verified the row belongs to this club.
const CLUB_AWARE_RPC_PARAM: Record<string, string> = {
  search_person_by_name: "target_club_id",
  reapply_waivers_for_everyone_with_debt: "target_club_id",
};

type Row = Record<string, unknown>;

function assertSameClubOrUnset(row: Row, clubId: string, table: string, verb: string) {
  if ("club_id" in row && row.club_id !== clubId) {
    throw new Error(`createClubScopedClient: ${verb} on "${table}" specified a different club_id`);
  }
}

export function createClubScopedClient(clubId: string) {
  const client = createAdminClient();

  return {
    clubId,
    from(table: ClubScopedTable) {
      const base = client.from(table);
      return {
        select: (
          columns = "*",
          opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }
        ) => base.select(columns, opts).eq("club_id", clubId),

        insert: (values: Row | Row[]) => {
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) assertSameClubOrUnset(row, clubId, table, "insert");
          const stamped = rows.map((row) => ({ ...row, club_id: clubId }));
          return base.insert(Array.isArray(values) ? stamped : stamped[0]);
        },

        upsert: (
          values: Row | Row[],
          opts?: { onConflict?: string; ignoreDuplicates?: boolean }
        ) => {
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) assertSameClubOrUnset(row, clubId, table, "upsert");
          const stamped = rows.map((row) => ({ ...row, club_id: clubId }));
          return base.upsert(Array.isArray(values) ? stamped : stamped[0], opts);
        },

        update: (values: Row) => {
          if ("club_id" in values) {
            throw new Error(`createClubScopedClient: update on "${table}" may not change club_id`);
          }
          return base.update(values).eq("club_id", clubId);
        },

        delete: () => base.delete().eq("club_id", clubId),
      };
    },

    rpc(name: string, args: Row = {}) {
      const clubArgName = CLUB_AWARE_RPC_PARAM[name];
      return client.rpc(name, clubArgName ? { ...args, [clubArgName]: clubId } : args);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/club-scoped-client.spec.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/supabase/club-scoped.ts tests/integration/club-scoped-client.spec.ts
git commit -m "feat(db): add createClubScopedClient guardrail (not yet wired into business logic)"
```

---

### Task 3: Migration — scope the Realtime RLS policy by club

**Files:**
- Create: `supabase/migrations/20261101090000_scope_attendance_realtime_by_club.sql`

**Interfaces:**
- Consumes: the `admin` table from Plan 1.
- Produces: the live `attendance_record_select_authenticated_admin` policy now checks `admin` scoped by `club_id` instead of the flat `admin_allowlist`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261101090000_scope_attendance_realtime_by_club.sql
-- Was checking admin_allowlist directly (any admin, any club, could
-- subscribe to any club's attendance_record rows). Scopes it to admin,
-- per club, so a Taekwondo admin's attendance screen also gets live
-- updates (admin_allowlist never had them) and a Judo admin can no
-- longer subscribe to Taekwondo's rows.
drop policy attendance_record_select_authenticated_admin on public.attendance_record;

create policy attendance_record_select_authenticated_admin on public.attendance_record
  for select
  to authenticated
  using (
    exists (
      select 1 from public.admin
      where email = lower((select auth.jwt() ->> 'email'))
        and club_id = attendance_record.club_id
    )
  );
```

- [ ] **Step 2: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "scope_attendance_realtime_by_club"`. If the Supabase MCP tools aren't directly callable, load them first: `ToolSearch(query: "select:mcp__supabase__apply_migration,mcp__supabase__execute_sql")`.

- [ ] **Step 3: Verify**

```sql
select polname, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid = 'public.attendance_record'::regclass;
```

Expected: one row, `polname = 'attendance_record_select_authenticated_admin'`, `using_expr` referencing `admin` and `club_id`, not `admin_allowlist`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261101090000_scope_attendance_realtime_by_club.sql
git commit -m "feat(db): scope attendance_record Realtime RLS policy by club"
```

---

### Task 4: `scripts/create-admin.ts` becomes club-aware

**Files:**
- Modify: `scripts/create-admin.ts`

**Interfaces:**
- Consumes: the `club` and `admin` tables.
- Produces: `node scripts/create-admin.ts <email> <club-slug>` — resolves the club, upserts into `admin(email, club_id)`, and (unchanged) upserts into `admin_allowlist(email)`. If the Supabase Auth user already exists, adds the `admin` row instead of exiting — one person administering two clubs is now a normal case.

- [ ] **Step 1: Rewrite the script**

```ts
// One-off admin account provisioning -- run manually, not exposed via the
// app. Usage: node scripts/create-admin.ts <email> <club-slug>
//
// Requires SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL in .env.local.
// Generates a strong random password for a NEW auth user (email_confirm:
// true, no confirmation email). If the auth user already exists, this is
// now a normal case -- it just adds the admin(email, club_id) row for the
// new club and prints no new password. Also upserts admin_allowlist, kept
// alongside admin as a rollback path for this release.

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not set");

const email = process.argv[2]?.trim().toLowerCase();
const clubSlug = process.argv[3]?.trim().toLowerCase();
if (!email || !email.includes("@") || !clubSlug) {
  console.error("Usage: node scripts/create-admin.ts <email> <club-slug>");
  process.exit(1);
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main() {
  const admin = createClient(supabaseUrl!, secretKey!, {
    auth: { persistSession: false },
  });

  const { data: club, error: clubError } = await admin
    .from("club")
    .select("id")
    .eq("slug", clubSlug!)
    .maybeSingle();
  if (clubError) {
    console.error(`Failed to look up club "${clubSlug}": ${clubError.message}`);
    process.exit(1);
  }
  if (!club) {
    console.error(`Unknown club slug: "${clubSlug}"`);
    process.exit(1);
  }

  const password = generatePassword();
  const { error: createError } = await admin.auth.admin.createUser({
    email: email!,
    password,
    email_confirm: true,
  });

  if (createError && createError.code !== "email_exists") {
    console.error(`Failed to create auth user for ${email}: ${createError.message}`);
    process.exit(1);
  }

  const { error: adminError } = await admin
    .from("admin")
    .upsert({ email: email!, club_id: club.id }, { onConflict: "email,club_id" });
  if (adminError) {
    console.error(`Auth user ready, but failed to add ${email} to admin for ${clubSlug}: ${adminError.message}`);
    process.exit(1);
  }

  const { error: allowlistError } = await admin
    .from("admin_allowlist")
    .upsert({ email: email! }, { onConflict: "email" });
  if (allowlistError) {
    console.error(`Added to admin, but failed to add ${email} to admin_allowlist: ${allowlistError.message}`);
    process.exit(1);
  }

  if (createError?.code === "email_exists") {
    console.log(`${email} already has an account -- added access to club "${clubSlug}". No new password.`);
  } else {
    console.log(`Created admin account for ${email}, club "${clubSlug}".`);
    console.log(`Password: ${password}`);
    console.log("Share this out-of-band (in person, group chat) -- never by email. It will not be shown again.");
  }
}

main();
```

- [ ] **Step 2: Manually verify against a throwaway test email**

Run: `node scripts/create-admin.ts smoke-test-$(date +%s)@example.test judo`
Expected: prints a generated password; re-running the same command for a second club slug (e.g. `taekwondo`) on the SAME email prints "already has an account -- added access" with no password.

- [ ] **Step 3: Commit**

```bash
git add scripts/create-admin.ts
git commit -m "feat(auth): make create-admin.ts club-aware (email + club-slug)"
```

---

### Task 5: Post-sign-in redirect, the club picker, and the root entry points

**Files:**
- Modify: `lib/auth/actions.ts`
- Modify: `app/page.tsx`
- Create: `app/select-club/page.tsx`
- Create: `app/club/[clubSlug]/page.tsx`
- Test: `tests/e2e/login-redirect.spec.ts` (new)

**Interfaces:**
- Consumes: `listAdminClubs(email)` from Task 1.
- Produces: signing in redirects to the right place for 0/1/many admin-club memberships.

- [ ] **Step 1: Write the failing e2e test**

```ts
// tests/e2e/login-redirect.spec.ts
import { test, expect } from "@playwright/test";

// These assert on the redirect target reachable from the login form's
// client-visible behavior, mirroring the existing admin-auth-gate.spec.ts
// pattern of checking URLs rather than seeding real Supabase Auth users
// (which these three cases would otherwise require).
test("the login page still renders the email/password form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("/select-club redirects an unauthenticated visitor to /login", async ({ page }) => {
  await page.goto("/select-club");
  await expect(page).toHaveURL(/\/login$/);
});

test("/club/judo redirects an unauthenticated visitor to /login", async ({ page }) => {
  await page.goto("/club/judo");
  await expect(page).toHaveURL(/\/login$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/e2e/login-redirect.spec.ts`
Expected: FAIL — `/select-club` and `/club/judo` don't exist yet (404 or unmatched route), so the redirect assertions fail.

- [ ] **Step 3: Rewrite `lib/auth/actions.ts`'s `signIn()`**

```ts
"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { listAdminClubs } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

export async function signIn(rawEmail: string, rawPassword: string): Promise<{ error?: string }> {
  const parsed = credentialsSchema.safeParse({ email: rawEmail, password: rawPassword });
  if (!parsed.success) {
    return { error: "Enter a valid email and password." };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email.toLowerCase(),
    password: parsed.data.password,
  });
  if (error) {
    return { error: "Invalid email or password." };
  }

  const clubs = await listAdminClubs(parsed.data.email.toLowerCase());
  if (clubs.length === 0) {
    await supabase.auth.signOut();
    return { error: "This account isn't an admin of any club." };
  }
  if (clubs.length === 1) {
    redirect(clubPath(clubs[0].slug, "/sessions"));
  }
  redirect("/select-club");
}

export async function signOut(): Promise<never> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
```

Note: `redirect()` throws internally — it must never sit inside the same `try/catch` as the sign-out call above it would need if an error path called both. Here the 0-club path explicitly returns an error object instead of throwing, so this is already correct; keep that shape if you touch this function later.

- [ ] **Step 4: Write `app/select-club/page.tsx`**

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { listAdminClubs } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const dynamic = "force-dynamic";

export default async function SelectClubPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  const clubs = await listAdminClubs(user.email);
  if (clubs.length === 0) redirect("/login");
  if (clubs.length === 1) redirect(clubPath(clubs[0].slug, "/sessions"));

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-20">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a club</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account administers more than one club.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {clubs.map((club) => (
          <Link
            key={club.clubId}
            href={clubPath(club.slug, "/sessions")}
            className="rounded-lg border p-4 hover:bg-muted"
          >
            {club.name}
          </Link>
        ))}
      </div>
      <SignOutButton />
    </div>
  );
}
```

- [ ] **Step 5: Write `app/club/[clubSlug]/page.tsx`**

Checks auth itself (same pattern as `app/select-club/page.tsx` and `app/page.tsx` above) rather than relying on `middleware.ts`'s matcher — which doesn't cover `/club/:path*` until Task 6 Step 7, so without this check an unauthenticated visitor to `/club/judo` would redirect straight to `/club/judo/sessions` instead of `/login`.

```tsx
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { clubPath } from "@/lib/club-path";

export default async function ClubIndexPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { clubSlug } = await params;
  redirect(clubPath(clubSlug, "/sessions"));
}
```

- [ ] **Step 6: Update `app/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { listAdminClubs } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) redirect("/login");

  const clubs = await listAdminClubs(user.email);
  if (clubs.length === 0) redirect("/login");
  if (clubs.length === 1) redirect(clubPath(clubs[0].slug, "/sessions"));
  redirect("/select-club");
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx playwright test tests/e2e/login-redirect.spec.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 8: Commit**

```bash
git add lib/auth/actions.ts app/page.tsx app/select-club/page.tsx app/club/\[clubSlug\]/page.tsx tests/e2e/login-redirect.spec.ts
git commit -m "feat(auth): post-sign-in club resolution, /select-club picker, /club/[clubSlug] index"
```

---

### Task 6: Move the attendance routes, actions, and components under `/club/[clubSlug]/`

**Files:**
- Move: `app/sessions/page.tsx` → `app/club/[clubSlug]/sessions/page.tsx`
- Move: `app/sessions/[sessionId]/page.tsx` → `app/club/[clubSlug]/sessions/[sessionId]/page.tsx`
- Move: `app/sessions/new/page.tsx` → `app/club/[clubSlug]/sessions/new/page.tsx`
- Move: `app/sessions/import/page.tsx` → `app/club/[clubSlug]/sessions/import/page.tsx`
- Modify: `lib/attendance/actions.ts`, `lib/csv-import/actions.ts`
- Modify: `components/attendance/session-picker.tsx`, `components/attendance/csv-importer.tsx`, `components/attendance/attendance-screen.tsx`, `components/attendance/add-attendee.tsx`, `components/attendance/sync-csv-button.tsx`
- Modify: `middleware.ts`
- Test: `tests/e2e/admin-auth-gate.spec.ts` (extended — see Task 8)

**Interfaces:**
- Consumes: `requireAdmin(clubSlug)` and `clubPath` from Task 1.
- Produces: every attendance-area Server Action now takes `clubSlug: string` as its first argument; every attendance-area page/component reads/threads `clubSlug` from its route params or props instead of a hardcoded `/sessions...` path.

- [ ] **Step 1: Move the 4 page files**

```bash
mkdir -p "app/club/[clubSlug]/sessions/[sessionId]" "app/club/[clubSlug]/sessions/new" "app/club/[clubSlug]/sessions/import"
git mv app/sessions/page.tsx "app/club/[clubSlug]/sessions/page.tsx"
git mv "app/sessions/[sessionId]/page.tsx" "app/club/[clubSlug]/sessions/[sessionId]/page.tsx"
git mv app/sessions/new/page.tsx "app/club/[clubSlug]/sessions/new/page.tsx"
git mv app/sessions/import/page.tsx "app/club/[clubSlug]/sessions/import/page.tsx"
```

- [ ] **Step 2: Rewrite `app/club/[clubSlug]/sessions/page.tsx`**

```tsx
import Link from "next/link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { clubPath } from "@/lib/club-path";
import { listRecentSessions } from "@/lib/attendance/queries";
import { countFailedChaseEmails } from "@/lib/chase/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const dynamic = "force-dynamic";

export default async function SessionsIndexPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  try {
    await requireAdmin(clubSlug);
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const [sessions, failedChaseCount] = await Promise.all([
    listRecentSessions(),
    countFailedChaseEmails(),
  ]);
  const todaySessions = sessions.filter((s) => s.isToday);
  const upcomingSessions = sessions.filter((s) => !s.isToday && s.isFuture).reverse();
  const pastSessions = sessions.filter((s) => !s.isToday && !s.isFuture);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a session to take attendance, or create a new one.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={clubPath(clubSlug, "/admin/unpaid")}>Unpaid sessions</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={clubPath(clubSlug, "/admin/chase-inbox")} className="flex items-center gap-2">
              Chase inbox
              {failedChaseCount > 0 && <Badge variant="destructive">{failedChaseCount} failed</Badge>}
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={clubPath(clubSlug, "/admin/purchases")}>Purchases</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={clubPath(clubSlug, "/sessions/new")}>New session (eActivities)</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={clubPath(clubSlug, "/sessions/import")}>New session (CSV import)</Link>
          </Button>
          <SignOutButton />
        </div>
      </div>

      {todaySessions.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-muted-foreground">Today</h2>
          <div className="mt-2 flex flex-col gap-2">
            {todaySessions.map((s) => (
              <SessionRow key={s.id} session={s} clubSlug={clubSlug} />
            ))}
          </div>
        </div>
      )}

      {upcomingSessions.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-muted-foreground">Upcoming</h2>
          <div className="mt-2 flex flex-col gap-2">
            {upcomingSessions.map((s) => (
              <SessionRow key={s.id} session={s} clubSlug={clubSlug} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-muted-foreground">Past (last 30 days)</h2>
        <div className="mt-2 flex flex-col gap-2">
          {pastSessions.length > 0 ? (
            pastSessions.map((s) => <SessionRow key={s.id} session={s} clubSlug={clubSlug} />)
          ) : (
            <p className="text-sm text-muted-foreground">No sessions in the last 30 days.</p>
          )}
        </div>
      </div>

      {sessions.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">No sessions yet — create one to get started.</p>
      )}
    </div>
  );
}

function SessionRow({
  session,
  clubSlug,
}: {
  session: { id: string; title: string; startsAt: string; attendeeCount: number; cancelledAt: string | null };
  clubSlug: string;
}) {
  return (
    <Link
      href={clubPath(clubSlug, `/sessions/${session.id}`)}
      className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-muted sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <div>
        <p className={`font-medium ${session.cancelledAt ? "line-through text-muted-foreground" : ""}`}>
          {session.title}
        </p>
        <p className="text-xs text-muted-foreground">{new Date(session.startsAt).toLocaleString()}</p>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        {session.cancelledAt && <Badge variant="destructive">Cancelled</Badge>}
        <Badge variant="secondary">
          {session.attendeeCount} attendee{session.attendeeCount === 1 ? "" : "s"}
        </Badge>
      </div>
    </Link>
  );
}
```

- [ ] **Step 3: Rewrite the other 3 moved pages the same way**

Apply the identical pattern to each — `params: Promise<{ clubSlug: string }>`, `const { clubSlug } = await params`, `requireAdmin(clubSlug)` in the try/catch, every `href="/sessions..."` → `href={clubPath(clubSlug, "/sessions...")}`, every Server Action call gains `clubSlug` as its first argument:

- `app/club/[clubSlug]/sessions/[sessionId]/page.tsx`: also destructure `sessionId` from the same awaited `params` object (it now carries both `clubSlug` and `sessionId`).
- `app/club/[clubSlug]/sessions/new/page.tsx`: the `← All sessions` link becomes `clubPath(clubSlug, "/sessions")`; pass `clubSlug={clubSlug}` as a new prop to `<SessionPicker events={...} clubSlug={clubSlug} />`.
- `app/club/[clubSlug]/sessions/import/page.tsx`: same link change; pass `clubSlug={clubSlug}` to `<CsvImporter clubSlug={clubSlug} />`.

- [ ] **Step 4: Update `lib/attendance/actions.ts`**

Every exported function takes `clubSlug: string` as its first argument, resolves `{ clubId }` via `requireAdmin(clubSlug)` (replacing the existing no-arg `requireAdmin()` call), and the two eActivities-backed functions add the temporary club gate right after that. Apply this to `getEventSignups`, `createSessionFromSignup`, `toggleAttendance`, `setSessionCancelled`, `searchPeople`, `addExistingPersonToSession`, `createWalkIn`, `triggerManualSync`, `getAttendanceList`. Example for the two eActivities-gated ones:

```ts
export async function getEventSignups(clubSlug: string, eventId: string) {
  await requireAdmin(clubSlug);
  const gate = process.env.EACTIVITIES_CLUB_SLUG;
  if (gate && clubSlug !== gate) {
    throw new Error("eActivities isn't available for this club yet — use CSV import instead.");
  }
  // ...unchanged body below this point...
}

export async function createSessionFromSignup(
  clubSlug: string,
  input: z.infer<typeof createSessionSchema>
): Promise<{ sessionId: string }> {
  await requireAdmin(clubSlug);
  const gate = process.env.EACTIVITIES_CLUB_SLUG;
  if (gate && clubSlug !== gate) {
    throw new Error("eActivities isn't available for this club yet — use CSV import instead.");
  }
  // ...unchanged body below this point...
}
```

The other 7 functions get only the `clubSlug` parameter and the `requireAdmin(clubSlug)` change — no gate, no other body change (their internal queries still run unscoped exactly as today; that's Plan 2b).

- [ ] **Step 5: Update `lib/csv-import/actions.ts`**

`createSessionFromCsv` and `syncCsvToSession` each take `clubSlug: string` as their first argument and call `requireAdmin(clubSlug)` the same way (today's code has no `requireAdmin()` call here at all per its own comment about testability for `lib/csv-import/importer.ts` — add one now, since this is a `"use server"` action file, not the plain importer module; verify the comment's exact file/function it refers to before assuming it applies here too).

- [ ] **Step 6: Update the 5 attendance components**

- `components/attendance/session-picker.tsx`: add `clubSlug: string` to the props type; pass it as `createSessionFromSignup(clubSlug, {...})`'s first argument; change `router.push(\`/sessions/${sessionId}\`)` to `router.push(clubPath(clubSlug, \`/sessions/${sessionId}\`))`; also thread `clubSlug` through to `getEventSignups(clubSlug, id)` inside `handleEventChange`.
- `components/attendance/csv-importer.tsx`: add `clubSlug: string` prop; pass it as the first argument to `createSessionFromCsv`/`syncCsvToSession`; update its `router.push` the same way as session-picker.
- `components/attendance/attendance-screen.tsx`: add `clubSlug: string` prop (passed down from the session detail page); change its `← All sessions` `Link href="/sessions"` to `clubPath(clubSlug, "/sessions")`; thread `clubSlug` to every attendance action it calls (`toggleAttendance`, `setSessionCancelled`, `triggerManualSync`, `getAttendanceList`) and to `<AddAttendee>`/`<SyncCsvButton>` as a new prop.
- `components/attendance/add-attendee.tsx`: add `clubSlug: string` prop; thread it as the first argument to `searchPeople`, `addExistingPersonToSession`, `createWalkIn`.
- `components/attendance/sync-csv-button.tsx`: add `clubSlug: string` prop; thread it to whichever csv-import action it calls.

- [ ] **Step 7: Update `middleware.ts`**

```ts
export const config = {
  matcher: ["/club/:path*", "/select-club"],
};
```

- [ ] **Step 8: Run the integration suite for this group**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/attendance-sync.spec.ts tests/integration/attendance-toggle.spec.ts tests/integration/session-list.spec.ts tests/integration/csv-import.spec.ts`
Expected: PASS — these tests call the underlying `lib/attendance/queries.ts`/`lib/attendance/sync.ts`/`lib/csv-import/importer.ts` functions directly (not the Server Actions changed in this task), so they're unaffected by this task's signature changes and should still be green. If any fail, the Server Action changes leaked into a file this task wasn't supposed to touch — investigate before continuing.

- [ ] **Step 9: Confirm the rest of the app still compiles**

Run: `npx tsc --noEmit`
Expected: no errors. `requireAdmin`'s `TRANSITIONAL_DEFAULT_CLUB_SLUG` default (Task 1) means the admin pages/actions this task hasn't touched yet (`app/admin/*`, `lib/purchase/actions.ts`, `lib/xlsx/uploader.ts`, `lib/chase/actions.ts`, `lib/person/actions.ts`) still compile with their existing no-argument `requireAdmin()` calls.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(routing): move attendance routes under /club/[clubSlug], thread clubSlug through actions"
```

---

### Task 7: Move the admin routes, actions, and components under `/club/[clubSlug]/`

**Files:**
- Move: `app/admin/unpaid/page.tsx` → `app/club/[clubSlug]/admin/unpaid/page.tsx`
- Move: `app/admin/purchases/page.tsx` → `app/club/[clubSlug]/admin/purchases/page.tsx`
- Move: `app/admin/chase-inbox/page.tsx` → `app/club/[clubSlug]/admin/chase-inbox/page.tsx`
- Modify: `lib/purchase/actions.ts`, `lib/xlsx/uploader.ts`, `lib/chase/actions.ts`, `lib/person/actions.ts`
- Modify: `components/purchase/purchases-table.tsx`, `components/purchase/recent-uploads.tsx`, `components/purchase/xlsx-uploader.tsx`, `components/chase/approval-actions.tsx`

**Interfaces:**
- Consumes: `requireAdmin(clubSlug)` and `clubPath` from Task 1.
- Produces: every admin-area Server Action takes `clubSlug: string` as its first argument; every admin-area page/component threads `clubSlug` instead of a hardcoded `/admin/...`/`/sessions` path.

- [ ] **Step 1: Move the 3 page files**

```bash
mkdir -p "app/club/[clubSlug]/admin/unpaid" "app/club/[clubSlug]/admin/purchases" "app/club/[clubSlug]/admin/chase-inbox"
git mv app/admin/unpaid/page.tsx "app/club/[clubSlug]/admin/unpaid/page.tsx"
git mv app/admin/purchases/page.tsx "app/club/[clubSlug]/admin/purchases/page.tsx"
git mv app/admin/chase-inbox/page.tsx "app/club/[clubSlug]/admin/chase-inbox/page.tsx"
```

- [ ] **Step 2: Rewrite `app/club/[clubSlug]/admin/chase-inbox/page.tsx`** (worked example — apply the identical pattern to the other 2)

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";
// ...existing imports for the chase inbox query/components, unchanged...

export const dynamic = "force-dynamic";

export default async function ChaseInboxPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  try {
    await requireAdmin(clubSlug);
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  // ...existing query calls and rendering, unchanged below this point,
  // except the "← All sessions" link:
  return (
    <div /* ...unchanged wrapper... */>
      <Link href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
        ← All sessions
      </Link>
      {/* ...unchanged rest of the page, passing clubSlug into <ApprovalActions clubSlug={clubSlug} .../> for each row... */}
    </div>
  );
}
```

Apply the same shape to `app/club/[clubSlug]/admin/unpaid/page.tsx` and `app/club/[clubSlug]/admin/purchases/page.tsx`: `params: Promise<{clubSlug}>`, `requireAdmin(clubSlug)`, the `← All sessions` link rewritten via `clubPath`, and `clubSlug` passed into whichever client component each page renders (`PurchasesTable`, `RecentUploads`, `XlsxUploader`).

- [ ] **Step 3: Update `lib/purchase/actions.ts` and `lib/xlsx/uploader.ts`**

`rematchUnmatchedPurchases`, `changeUploadProduct`, `undoUpload` (in `lib/purchase/actions.ts`) and `uploadXlsx` (in `lib/xlsx/uploader.ts`) each take `clubSlug: string` as their first argument and call `requireAdmin(clubSlug)` in place of the existing no-arg call.

- [ ] **Step 4: Update `lib/chase/actions.ts`**

`approveChase`, `sendChase`, `rejectChase` each take `clubSlug: string` as their first argument and call `requireAdmin(clubSlug)` in place of the existing no-arg call.

- [ ] **Step 5: Update `lib/person/actions.ts`**

`setPersonExempt` takes `clubSlug: string` as its first argument and calls `requireAdmin(clubSlug)`.

- [ ] **Step 6: Update the 4 admin components**

- `components/purchase/purchases-table.tsx`: add `clubSlug: string` prop; thread it to `rematchUnmatchedPurchases`, `changeUploadProduct`, `undoUpload` wherever each is called.
- `components/purchase/recent-uploads.tsx`: add `clubSlug: string` prop; thread it the same way to whichever of the above it calls.
- `components/purchase/xlsx-uploader.tsx`: add `clubSlug: string` prop; thread it as `uploadXlsx`'s first argument (its `formData`-based call site needs `clubSlug` passed alongside the existing `FormData`, not inside it).
- `components/chase/approval-actions.tsx`: add `clubSlug: string` prop; thread it as the first argument to `approveChase`, `sendChase`, `rejectChase`.

- [ ] **Step 7: Run the integration suite for this group**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/chase-approval.spec.ts tests/integration/chase-send.spec.ts tests/integration/ingest-purchases.spec.ts tests/integration/purchase-upload.spec.ts tests/integration/purchase-waivers.spec.ts tests/integration/person-exempt.spec.ts`
Expected: PASS — same reasoning as Task 6 Step 8: these call the underlying `lib/` functions directly, not the Server Action wrappers changed here.

- [ ] **Step 8: Confirm the rest of the app still compiles**

Run: `npx tsc --noEmit`
Expected: no errors. After this task, every pre-existing `requireAdmin()` call site in the app has been converted (Tasks 6–7 together cover all of them) — this is the point where Task 9 becomes safe to run.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(routing): move admin routes under /club/[clubSlug], thread clubSlug through actions"
```

---

### Task 8: Extend the e2e auth-gate suite for club-scoped routes

**Files:**
- Modify: `tests/e2e/admin-auth-gate.spec.ts`

**Interfaces:**
- Consumes: the moved routes from Tasks 6–7.

- [ ] **Step 1: Write the failing test additions**

```ts
// append to tests/e2e/admin-auth-gate.spec.ts's existing test.describe block
for (const path of [
  "/club/judo",
  "/club/judo/sessions",
  "/club/judo/sessions/new",
  "/club/judo/sessions/import",
  "/club/judo/admin/purchases",
  "/club/judo/admin/chase-inbox",
  "/club/judo/admin/unpaid",
  "/select-club",
]) {
  test(`${path} redirects an unauthenticated visitor to /login`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  });
}

test("an unknown club slug redirects an unauthenticated visitor to /login, same as a known one", async ({ page }) => {
  await page.goto("/club/not-a-real-club/sessions");
  await expect(page).toHaveURL(/\/login$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts`
Expected: FAIL for every new `/club/...` path — `middleware.ts` doesn't cover them yet unless Task 6 Step 7 already ran. If you're executing tasks in order, this should already pass by the time you reach this task; if it fails, Task 6's middleware change didn't take effect — investigate before writing any new code here.

- [ ] **Step 3: Confirm the old `/sessions` and `/admin/*` paths now 404 or are unmatched**

Add, confirming the routes genuinely moved rather than just gaining a sibling:

```ts
test("the old /sessions path no longer exists", async ({ page }) => {
  const response = await page.goto("/sessions");
  expect(response?.status()).toBe(404);
});
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts`
Expected: PASS, every test including the new ones.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/admin-auth-gate.spec.ts
git commit -m "test: extend admin-auth-gate suite for club-scoped routes"
```

---

### Task 9: Remove `requireAdmin`'s transitional default

**Files:**
- Modify: `lib/auth/require-admin.ts`

**Interfaces:**
- Consumes: every call site converted by Tasks 6–7.
- Produces: `requireAdmin(clubSlug: string)` — `clubSlug` required, no default. This closes the compile-time loophole Task 1 opened on purpose; after this task, forgetting to pass `clubSlug` anywhere in the app is a build error, not a silent fallback to Judo.

- [ ] **Step 1: Remove the default**

In `lib/auth/require-admin.ts`, delete the `TRANSITIONAL_DEFAULT_CLUB_SLUG` constant and its explanatory comment, and change:

```ts
export async function requireAdmin(
  clubSlug: string = TRANSITIONAL_DEFAULT_CLUB_SLUG
): Promise<{ email: string; clubId: string; clubName: string }> {
```

to:

```ts
export async function requireAdmin(
  clubSlug: string
): Promise<{ email: string; clubId: string; clubName: string }> {
```

- [ ] **Step 2: Confirm the whole app still compiles with the default gone**

Run: `npx tsc --noEmit`
Expected: no errors. If this fails, some caller was missed in Tasks 6–7 — find it via the compiler's own error (it will name the exact file/line calling `requireAdmin()` with no argument) and fix that call site directly as part of this task, rather than reintroducing the default.

- [ ] **Step 3: Run the full test suite**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts tests/e2e/login-redirect.spec.ts` and `npx playwright test --config=playwright.integration.config.ts`
Expected: PASS — everything from every earlier task in this plan, now with no transitional default anywhere.

- [ ] **Step 4: Commit**

```bash
git add lib/auth/require-admin.ts
git commit -m "feat(auth): make requireAdmin(clubSlug) required, remove the transitional default"
```
