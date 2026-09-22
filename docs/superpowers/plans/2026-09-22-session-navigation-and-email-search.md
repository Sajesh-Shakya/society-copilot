# Session Navigation & Email Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin land on a list of recent/today's sessions after login instead of being forced to create a new one every time (AC-9), and let person search match on email as well as name (AC-10).

**Architecture:** AC-9 adds a plain read function (`listRecentSessions`) and a new `/sessions` index page, following this codebase's existing session-page conventions exactly; the post-login redirect changes from `/sessions/new` to `/sessions`. AC-10 is a `create or replace function` migration widening the existing `search_person_by_name` Postgres RPC to also substring-match on email, with no call-site changes required anywhere.

**Tech Stack:** Next.js App Router (Server Components), Supabase (Postgres RPC + service-role admin client), Playwright (integration + e2e).

**Spec:** `specs/attendance-payment-chasing/design.md`, `specs/attendance-payment-chasing/requirements.md` (AC-9, AC-10).

## Global Constraints

- **No new tables.** AC-9 reads the existing `session` table (confirmed live columns: `id uuid`, `eactivities_event_id text nullable`, `title text not null`, `starts_at timestamptz not null`, `created_at timestamptz not null default now()`, `eactivities_signup_id text nullable`, `last_synced_at timestamptz nullable`). AC-10 modifies the existing `search_person_by_name` function in place — same name, same signature (`search_query text, match_limit int default 8`), same return columns (`id uuid, full_name text, email text, cid text, similarity real`) — so every existing caller keeps working unchanged.
- **"Recent sessions" window (AC-9):** sessions where `starts_at >= now() - interval '30 days'` OR `starts_at > now()` (a session can be created ahead of its start time), ordered by `starts_at` descending (nearest-to-now first). No pagination — out of scope unless the list turns out large, which isn't the case yet.
- **"Today" grouping (AC-9):** compare each session's `starts_at` calendar date (UTC) against today's UTC calendar date. This codebase does not do per-admin-timezone handling anywhere else (e.g. `lib/chase/generator.ts`'s cadence math is plain UTC `Date` arithmetic) — match that level of simplicity, don't add timezone-awareness here.
- **Email matching (AC-10):** widen the `WHERE` clause to `full_name % search_query OR email ilike '%' || search_query || '%'` (substring match — email format doesn't benefit from trigram fuzziness the way names do). For the `similarity` column, use `greatest(similarity(full_name, search_query), (case when email ilike '%' || search_query || '%' then 1 else 0 end))` so a substring email match (a precise hit) sorts above fuzzy name matches, while name-similarity ordering is preserved among the rest.
- **Existing page pattern to follow exactly** (`app/sessions/[sessionId]/page.tsx`, `app/admin/purchases/page.tsx`): async server component, `export const dynamic = "force-dynamic"`, and
  ```typescript
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }
  ```
  as the very first thing in the component body. Plain `<table>`/shadcn primitives, no new UI framework or client-state library.
- **Existing read-function pattern to follow exactly** (`lib/attendance/queries.ts`'s `getSessionWithAttendance`): a plain (no `"use server"`) async function using `createAdminClient()`, called directly by the page after the page's own `requireAdmin()` check — not itself wrapped in a Server Action. This codebase's established precedent uses supabase-js embedded joins (see `getSessionWithAttendance`'s `person:person_id(id, full_name, email)`) — embedded/joined selects are fine to use here.
- **Test hygiene (non-negotiable):** every integration test inserts/deletes its own rows; `afterEach` deletes in FK-safe order and checks/throws on every delete's error.
- **Explicitly out of scope for this plan:** refactoring `lib/attendance/actions.ts`'s "use server" file structure (it mixes auth-gating and DB logic — a pre-existing pattern from before this session's later "thin wrapper" convention; not this plan's job to fix); session double-booking/conflict detection; pagination on the session list.

---

### Task 1: Extend person search to match email (AC-10)

**Files:**
- Create: `supabase/migrations/20260922100000_add_email_match_to_person_search.sql`
- Test: `tests/integration/person-search.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks in this plan (independent).
- Produces: the same RPC function signature/return shape already relied on by `lib/attendance/actions.ts`'s `searchPeople()` — no changes needed there. Nothing else in this plan depends on this task's output, so it can be done in any order relative to Tasks 2-3.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/person-search.spec.ts`. This calls the RPC function directly via the admin client — the same way `lib/attendance/actions.ts`'s `searchPeople()` does — rather than going through that file's `"use server"`-gated wrapper, which needs a real Next.js request context to exercise meaningfully.

```typescript
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

interface SearchRow {
  id: string;
  full_name: string;
  email: string;
  cid: string | null;
  similarity: number;
}

async function search(query: string): Promise<SearchRow[]> {
  const { data, error } = await admin.rpc("search_person_by_name", { search_query: query });
  if (error) throw error;
  return data as SearchRow[];
}

async function createPerson(fullName: string, email: string) {
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: fullName, email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("search_person_by_name with email matching", () => {
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length === 0) return;
    const { error } = await admin.from("person").delete().in("id", personIds);
    if (error) throw error;
    personIds = [];
  });

  test("still matches on fuzzy name similarity (existing behavior)", async () => {
    const id = await createPerson("Jonathan Smithe", `search-test-${crypto.randomUUID()}@example.test`);
    personIds.push(id);

    const results = await search("Jonathan Smith");
    expect(results.some((r) => r.id === id)).toBe(true);
  });

  test("matches on an email substring even when the name is completely different", async () => {
    const uniqueLocalPart = `zqx-${crypto.randomUUID()}`;
    const email = `${uniqueLocalPart}@example.test`;
    const id = await createPerson("Completely Unrelated Name", email);
    personIds.push(id);

    const results = await search(uniqueLocalPart);
    expect(results.some((r) => r.id === id)).toBe(true);
  });

  test("an email substring match ranks above a fuzzy name match", async () => {
    const sharedToken = `rankcheck${crypto.randomUUID().replace(/-/g, "")}`;
    // Email match: the token appears in the email, name is unrelated.
    const emailMatchId = await createPerson("Zzz Unrelated", `${sharedToken}@example.test`);
    // Name match: the token appears in the name (imperfect fuzzy match), email is unrelated.
    const nameMatchId = await createPerson(sharedToken, `other-${crypto.randomUUID()}@example.test`);
    personIds.push(emailMatchId, nameMatchId);

    const results = await search(sharedToken);
    const emailMatchIndex = results.findIndex((r) => r.id === emailMatchId);
    const nameMatchIndex = results.findIndex((r) => r.id === nameMatchId);
    expect(emailMatchIndex).toBeGreaterThanOrEqual(0);
    expect(nameMatchIndex).toBeGreaterThanOrEqual(0);
    expect(emailMatchIndex).toBeLessThan(nameMatchIndex);
  });

  test("does not match an unrelated person", async () => {
    const id = await createPerson("Totally Unrelated Person", `unrelated-${crypto.randomUUID()}@example.test`);
    personIds.push(id);

    const results = await search(`nonexistent-query-${crypto.randomUUID()}`);
    expect(results.some((r) => r.id === id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- person-search`
Expected: the second and third tests FAIL (email substring matching doesn't exist yet); the first and fourth should already pass against the current function.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260922100000_add_email_match_to_person_search.sql`:

```sql
-- Migration: widen person search to also match on email (AC-10)
-- specs/attendance-payment-chasing/requirements.md AC-10
--
-- Email is person's unique identifier. A name search alone can miss a
-- correctly-spelled email attached to an unfamiliar or misspelled name.
-- Same function name/signature/return shape as before -- every existing
-- caller (lib/attendance/actions.ts's searchPeople()) keeps working
-- unchanged.

create or replace function public.search_person_by_name(search_query text, match_limit int default 8)
returns table (id uuid, full_name text, email text, cid text, similarity real)
language sql
stable
as $$
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
  where full_name % search_query
     or email ilike '%' || search_query || '%'
  order by similarity desc
  limit match_limit;
$$;
```

Apply it with the Supabase MCP tool (`mcp__supabase__apply_migration`, name `add_email_match_to_person_search`, using the SQL above) rather than only writing the file — this project's convention is that migrations are applied live during development, not just committed as files.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- person-search`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260922100000_add_email_match_to_person_search.sql tests/integration/person-search.spec.ts
git commit -m "feat(attendance): match person search on email as well as name (AC-10)"
```

---

### Task 2: Session list read function (AC-9, backend)

**Files:**
- Modify: `lib/attendance/queries.ts`
- Test: `tests/integration/session-list.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent). Reads the existing `session` and `attendance_record` tables directly.
- Produces (for Task 3):
  ```typescript
  export interface SessionListItem {
    id: string;
    title: string;
    startsAt: string;
    attendeeCount: number;
    isToday: boolean;
  }

  export async function listRecentSessions(): Promise<SessionListItem[]>
  ```
  Sorted by `startsAt` descending (nearest-to-now first). `isToday` is true when the session's `startsAt` falls on today's UTC calendar date.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/session-list.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listRecentSessions } from "@/lib/attendance/queries";

const admin = createAdminClient();

async function createSession(title: string, startsAt: Date) {
  const { data, error } = await admin
    .from("session")
    .insert({ title, starts_at: startsAt.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createPerson() {
  const { data, error } = await admin
    .from("person")
    .insert({
      full_name: "Session List Test Person",
      email: `session-list-test-${crypto.randomUUID()}@example.test`,
      is_exempt: false,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("listRecentSessions", () => {
  let sessionIds: string[] = [];
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length > 0) {
      const { error: attendanceError } = await admin
        .from("attendance_record")
        .delete()
        .in("session_id", sessionIds);
      if (attendanceError) throw attendanceError;
      const { error: sessionError } = await admin.from("session").delete().in("id", sessionIds);
      if (sessionError) throw sessionError;
      sessionIds = [];
    }
    if (personIds.length > 0) {
      const { error: personError } = await admin.from("person").delete().in("id", personIds);
      if (personError) throw personError;
      personIds = [];
    }
  });

  test("includes a session from today and marks it isToday", async () => {
    const id = await createSession("Today's Test Session", new Date());
    sessionIds.push(id);

    const results = await listRecentSessions();
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.isToday).toBe(true);
  });

  test("includes a session from 10 days ago and marks it not isToday", async () => {
    const id = await createSession(
      "Ten Days Ago Test Session",
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions();
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.isToday).toBe(false);
  });

  test("excludes a session from 40 days ago", async () => {
    const id = await createSession(
      "Forty Days Ago Test Session",
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions();
    expect(results.some((r) => r.id === id)).toBe(false);
  });

  test("includes a future-dated session", async () => {
    const id = await createSession(
      "Future Test Session",
      new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions();
    expect(results.some((r) => r.id === id)).toBe(true);
  });

  test("reports the correct attendee count", async () => {
    const sessionId = await createSession("Attendee Count Test Session", new Date());
    sessionIds.push(sessionId);
    const personId = await createPerson();
    personIds.push(personId);
    const { error } = await admin
      .from("attendance_record")
      .insert({ person_id: personId, session_id: sessionId, source: "manual_tick" });
    if (error) throw error;

    const results = await listRecentSessions();
    const found = results.find((r) => r.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.attendeeCount).toBe(1);
  });

  test("orders by startsAt descending (nearest-to-now first)", async () => {
    const olderId = await createSession(
      "Older Test Session",
      new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    );
    const newerId = await createSession("Newer Test Session", new Date());
    sessionIds.push(olderId, newerId);

    const results = await listRecentSessions();
    const olderIndex = results.findIndex((r) => r.id === olderId);
    const newerIndex = results.findIndex((r) => r.id === newerId);
    expect(newerIndex).toBeLessThan(olderIndex);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- session-list`
Expected: FAIL — `listRecentSessions` is not exported from `@/lib/attendance/queries` yet.

- [ ] **Step 3: Add `listRecentSessions` to `lib/attendance/queries.ts`**

Open `lib/attendance/queries.ts`. It currently exports `AttendanceRow`, `SessionWithAttendance`, and `getSessionWithAttendance`. Add the following at the end of the file (after `getSessionWithAttendance`'s closing brace):

```typescript
export interface SessionListItem {
  id: string;
  title: string;
  startsAt: string;
  attendeeCount: number;
  isToday: boolean;
}

function isUtcToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

/**
 * AC-9: sessions from the last 30 days, plus any future-dated session (a
 * session can be created ahead of its start time), newest-starting first.
 * Server-only read (admin client) -- caller checks admin identity first,
 * same convention as getSessionWithAttendance above.
 */
export async function listRecentSessions(): Promise<SessionListItem[]> {
  const admin = createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: sessions, error: sessionsError } = await admin
    .from("session")
    .select("id, title, starts_at")
    .gte("starts_at", thirtyDaysAgo)
    .order("starts_at", { ascending: false });
  if (sessionsError) throw sessionsError;

  const sessionIds = (sessions ?? []).map((s) => s.id);
  const countsBySessionId = new Map<string, number>();
  if (sessionIds.length > 0) {
    const { data: attendanceRows, error: attendanceError } = await admin
      .from("attendance_record")
      .select("session_id")
      .in("session_id", sessionIds);
    if (attendanceError) throw attendanceError;
    for (const row of attendanceRows ?? []) {
      countsBySessionId.set(row.session_id, (countsBySessionId.get(row.session_id) ?? 0) + 1);
    }
  }

  return (sessions ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    startsAt: s.starts_at,
    attendeeCount: countsBySessionId.get(s.id) ?? 0,
    isToday: isUtcToday(s.starts_at),
  }));
}
```

Note the query only fetches `starts_at >= thirtyDaysAgo` (i.e. "last 30 days or later", which naturally includes any future-dated session too, since a future date is always `>=` a past cutoff) — this single filter satisfies both halves of the "last 30 days OR future" requirement without needing an `OR` clause.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- session-list`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add lib/attendance/queries.ts tests/integration/session-list.spec.ts
git commit -m "feat(attendance): add listRecentSessions for the sessions index (AC-9)"
```

---

### Task 3: Sessions index page and post-login redirect (AC-9, frontend)

**Files:**
- Create: `app/sessions/page.tsx`
- Modify: `app/auth/callback/route.ts`
- Modify: `tests/e2e/admin-auth-gate.spec.ts`

**Interfaces:**
- Consumes: `listRecentSessions(): Promise<SessionListItem[]>` from `@/lib/attendance/queries` (Task 2), where `SessionListItem = {id: string; title: string; startsAt: string; attendeeCount: number; isToday: boolean}`.
- Produces: nothing consumed by a later task — this is the final task in the plan.

- [ ] **Step 1: Implement the sessions index page**

Create `app/sessions/page.tsx`:

```typescript
import Link from "next/link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { listRecentSessions } from "@/lib/attendance/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const dynamic = "force-dynamic";

export default async function SessionsIndexPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const sessions = await listRecentSessions();
  const todaySessions = sessions.filter((s) => s.isToday);
  const otherSessions = sessions.filter((s) => !s.isToday);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a session to take attendance, or create a new one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/sessions/new">New session</Link>
          </Button>
          <SignOutButton />
        </div>
      </div>

      {todaySessions.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-muted-foreground">Today</h2>
          <div className="mt-2 flex flex-col gap-2">
            {todaySessions.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {todaySessions.length > 0 ? "Other recent sessions" : "Recent sessions"}
        </h2>
        <div className="mt-2 flex flex-col gap-2">
          {otherSessions.length > 0 ? (
            otherSessions.map((s) => <SessionRow key={s.id} session={s} />)
          ) : (
            <p className="text-sm text-muted-foreground">No other sessions in the last 30 days.</p>
          )}
        </div>
      </div>

      {sessions.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">
          No sessions yet — create one to get started.
        </p>
      )}
    </div>
  );
}

function SessionRow({
  session,
}: {
  session: { id: string; title: string; startsAt: string; attendeeCount: number };
}) {
  return (
    <Link
      href={`/sessions/${session.id}`}
      className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted"
    >
      <div>
        <p className="font-medium">{session.title}</p>
        <p className="text-xs text-muted-foreground">{new Date(session.startsAt).toLocaleString()}</p>
      </div>
      <Badge variant="secondary">{session.attendeeCount} attendee{session.attendeeCount === 1 ? "" : "s"}</Badge>
    </Link>
  );
}
```

- [ ] **Step 2: Change the post-login redirect**

In `app/auth/callback/route.ts`, change:

```typescript
      return NextResponse.redirect(`${origin}/sessions/new`);
```

to:

```typescript
      return NextResponse.redirect(`${origin}/sessions`);
```

This is the only change to this file — leave the rest (the `code` exchange, the `/login` fallback) untouched.

- [ ] **Step 3: Add the new route to the admin gating e2e test**

In `tests/e2e/admin-auth-gate.spec.ts`, change the `for` loop's array from:

```typescript
  for (const path of ["/sessions/new", "/admin/purchases", "/admin/chase-inbox"]) {
```

to:

```typescript
  for (const path of ["/sessions", "/sessions/new", "/admin/purchases", "/admin/chase-inbox"]) {
```

- [ ] **Step 4: Run the e2e gating test**

Run: `npm run test:e2e -- admin-auth-gate`
Expected: PASS (4 routes, all redirect to `/login`).

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no new errors (the codebase's one pre-existing unrelated warning in `lib/pluto/client.ts` is expected).

- [ ] **Step 6: Commit**

```bash
git add app/sessions/page.tsx app/auth/callback/route.ts tests/e2e/admin-auth-gate.spec.ts
git commit -m "feat(attendance): add sessions index page, redirect post-login here instead of /sessions/new (AC-9)"
```

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage:** AC-9 (session list, today grouping, post-login redirect, new-session link) → Task 2 (backend) + Task 3 (page + redirect). AC-10 (email matching in person search) → Task 1.
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type consistency:** `SessionListItem` is defined once in Task 2 and consumed with the exact same shape in Task 3's `SessionRow` component and page filtering logic (`isToday`, `attendeeCount`, `startsAt`, `title`, `id` — every field used in Task 3 exists on the Task 2 interface, and vice versa nothing in Task 2's interface goes unused).
