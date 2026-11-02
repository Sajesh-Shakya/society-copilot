# Plan 2b-2: Application-Layer Club-Scoping Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread a real, request-derived `clubId` through every read/write path the Plan 2 design doc identified as still cross-tenant-unsafe, and delete the Plan 1 `getDefaultClubId` hotfix once every call site is converted.

**Architecture:** Plan 2a already gives every admin-gated entry point a real `clubId` via `requireAdmin(clubSlug)`. Plan 2b-1 already made the DB layer club-aware (composite FKs, `search_person_by_name`/`toggle_attendance`/`reapply_waivers_for_everyone_with_debt` club-scoped, `purchase_upload.club_id`, per-club product uniqueness). This plan is the layer in between: every `lib/*` function between the Server Action and the database currently either ignores `clubId` entirely or only half-uses it. The fix is mechanical and repeats one pattern per file: add a `clubId` parameter, and either (a) swap `createAdminClient()` for `createClubScopedClient(clubId)` so every query is auto-filtered/stamped, or (b) add an explicit `.eq("club_id", clubId)` where the scoped client's table allowlist or an RPC's signature doesn't cover it. The one genuinely new piece of logic is a small `assertSessionBelongsToClub` helper that closes the `toggle_attendance`/session-by-id IDOR gap the audit found, since that RPC is deliberately row-scoped (not club-scoped) at the DB layer.

**Tech Stack:** Next.js App Router Server Actions, Supabase (service-role admin client + the `createClubScopedClient` guardrail wrapper), Zod, Playwright (`tests/integration`, config `playwright.integration.config.ts`).

**Spec:** `docs/superpowers/specs/2026-11-01-multi-tenancy-plan2-design.md` (see its "Plan 2b" section). This plan also incorporates two findings from a fresh code audit on 2026-11-02 that the design doc didn't anticipate: (1) `session` is missing from `createClubScopedClient`'s table allowlist even though it's used throughout attendance/csv-import; (2) `findOrCreatePerson`/`findOrCreatePersonByEmail` already take a `clubId` parameter but only use it on INSERT — their CID/email lookup queries are unscoped, a real cross-tenant person-matching leak that predates this plan.

## Global Constraints

- Every `lib/*` function that reads or writes a club-scoped table must take a `clubId: string` parameter sourced from a `requireAdmin(clubSlug)` call at the Server Action boundary — never resolved internally via `getDefaultClubId` or a hardcoded slug.
- Prefer `createClubScopedClient(clubId)` (from `lib/supabase/club-scoped.ts`) over `createAdminClient()` wherever the table is in `CLUB_SCOPED_TABLES`; it auto-stamps `club_id` on insert/upsert and auto-filters `select`/`update`/`delete` by it, which closes most of this plan's IDOR gaps as a side effect of the swap. Use `createAdminClient()` directly only for tables outside the allowlist (`club`, `admin`) or where a function spans multiple clubs by design (the cron route's loop).
- A row-scoped RPC (`toggle_attendance`, `apply_purchase_waiver`, `reapply_waivers_for_person`) takes no club argument by design (Plan 2b-1) — the caller must verify the row it's operating on belongs to `clubId` *before* calling it. Use the new `assertSessionBelongsToClub` helper (Task 2) for session-scoped calls; the existing scoped-client `.select().eq("club_id", clubId)` pattern covers person/purchase-scoped ones.
- Never widen `CLUB_SCOPED_TABLES` to include `club` or `admin` themselves — those are cross-club by definition and already queried directly via `createAdminClient()` in `lib/auth/require-admin.ts`.
- Delete `lib/supabase/default-club.ts` and every remaining `getDefaultClubId` import only in the final task (Task 14), once a `grep -rn "getDefaultClubId"` shows zero application call sites left.
- Run the full integration suite (`npm run test:integration`) after every task; it must stay green throughout — this suite already runs `workers: 1` serially (see `chase-generator.spec.ts`'s comment), so no new serialization concerns.
- Every test file's cleanup must use `test.afterEach`, never inline end-of-test deletes (see the just-merged `harden-test-cleanup` branch) — any new test added by this plan follows that convention from the start.

## Review Focus

- **A Judo admin passing a Taekwondo `sessionId`/`personId` to a by-id Server Action** (`toggleAttendance`, `setSessionCancelled`, `addExistingPersonToSession`, `createWalkIn`, `triggerManualSync`, `getAttendanceList`) must be rejected, not silently succeed across clubs — this is the core IDOR the audit flagged; Tasks 2-3 own it via `assertSessionBelongsToClub` and the scoped client's auto-filtering.
- **A purchase upload in Club B auto-matching to a person who belongs to Club A** purely by coincidental CID/email/name — `matchPersonRecord`'s three match rules currently have zero club filter; Task 5 owns it.
- **The weekly chase-email cron silently stops covering every club except Judo** once `reapplyWaiversForEveryoneWithDebt`/`generateChaseEmails`/`processAutoSends` gain required `clubId` parameters — the route must loop every club, not just call each function once; Task 11 owns it.
- **`changeUploadProduct`'s `newProductId` belonging to a different club than the upload it's correcting** — the design doc calls this out explicitly ("also verifying `newProductId` belongs to the club"); Task 7 owns it.
- **A function this plan doesn't touch still importing `getDefaultClubId` after Task 14's cleanup** — Task 14's own grep step is the test for this; an incomplete sweep would otherwise ship silently since the hotfix still "works" (it just always resolves Judo).

---

## Task 1: `createClubScopedClient` gains `session`; `findOrCreatePerson`'s lookups become club-scoped

**Files:**
- Modify: `lib/supabase/club-scoped.ts`
- Modify: `lib/attendance/sync.ts`
- Test: `tests/integration/club-scoped-client.spec.ts`, `tests/integration/attendance-sync.spec.ts`

**Interfaces:**
- Consumes: `createClubScopedClient(clubId)` (existing, from `lib/supabase/club-scoped.ts`).
- Produces: `CLUB_SCOPED_TABLES` now includes `"session"`. `findOrCreatePerson(admin, attendee, clubId)` keeps its existing signature but every query inside it is now club-filtered. `syncSessionAttendance(sessionId, clubId, options?)` — **signature change**: `clubId` becomes the new required second positional argument (options shifts to third).

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/club-scoped-client.spec.ts` (read the existing file first for its exact admin/clubId setup pattern, then add this `test.describe` block alongside the existing ones):

```ts
test.describe("createClubScopedClient covers the session table", () => {
  let sessionIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length) await admin.from("session").delete().in("id", sessionIds);
    sessionIds = [];
  });

  test("insert on session auto-stamps club_id and select filters by it", async () => {
    const judo = await clubId("judo");
    const scoped = createClubScopedClient(judo);

    const { data: inserted, error } = await scoped
      .from("session")
      .insert({ title: "Scoped Client Session Test", starts_at: new Date().toISOString() })
      .select("id, club_id")
      .single();
    expect(error).toBeNull();
    expect(inserted!.club_id).toBe(judo);
    sessionIds.push(inserted!.id);

    const taekwondo = await clubId("taekwondo");
    const scopedAsTaekwondo = createClubScopedClient(taekwondo);
    const { data: notFound } = await scopedAsTaekwondo
      .from("session")
      .select("id")
      .eq("id", inserted!.id)
      .maybeSingle();
    expect(notFound).toBeNull();
  });
});
```

(This file already has a `clubId(slug)` helper and `createClubScopedClient` imported — reuse them; don't redefine.)

Add to `tests/integration/attendance-sync.spec.ts`, inside the existing `test.describe("syncSessionAttendance", ...)` block, a new test:

```ts
  test("matching an attendee by CID never returns a person from a different club", async () => {
    const taekwondoId = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const sharedCid = `shared-cid-${crypto.randomUUID().slice(0, 8)}`;
    const { data: taekwondoPerson, error: tkdError } = await admin
      .from("person")
      .insert({
        club_id: taekwondoId.data!.id,
        full_name: "Taekwondo Person (CID collision)",
        email: `tkd-sync-collision-${crypto.randomUUID()}@example.test`,
        cid: sharedCid,
      })
      .select("id")
      .single();
    if (tkdError) throw tkdError;
    personIds.push(taekwondoPerson!.id);

    const sessionId = await createSession(`signup-${crypto.randomUUID()}`);
    sessionIds.push(sessionId);

    const provider = fakeProvider([
      { FirstName: "Judo", Surname: "Attendee", CID: sharedCid, Email: `judo-sync-${crypto.randomUUID()}@example.test`, Login: null },
    ]);

    const result = await syncSessionAttendance(sessionId, judoClubId, { provider });
    expect(result.personsCreated).toBe(1); // a NEW Judo person, not a match on the Taekwondo one

    const { data: created } = await admin
      .from("person")
      .select("id, club_id")
      .eq("cid", sharedCid)
      .eq("club_id", judoClubId)
      .single();
    expect(created).toBeTruthy();
    personIds.push(created!.id);
  });
```

Update every existing call to `syncSessionAttendance(sessionId, ...)` in this same file to pass `judoClubId` as the second argument (e.g. `syncSessionAttendance(sessionId, { provider })` becomes `syncSessionAttendance(sessionId, judoClubId, { provider })`) — there are 5 such call sites in the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/club-scoped-client.spec.ts tests/integration/attendance-sync.spec.ts`
Expected: FAIL — the new `session`-table test fails because `session` isn't in `CLUB_SCOPED_TABLES` yet (`createClubScopedClient: ...` type error or a runtime "table not in allowlist" style failure depending on how the allowlist is enforced — check `lib/supabase/club-scoped.ts`'s `from()` signature); the new CID-collision test and the updated call sites fail to compile because `syncSessionAttendance` doesn't yet accept a second positional `clubId` argument.

- [ ] **Step 3: Implement**

In `lib/supabase/club-scoped.ts`, add `"session"` to the table list:

```ts
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
```

(It's already there verbatim in the current file — confirm with a read before editing; if it's already present, this step is a no-op and the test in Step 1 should already pass once the rest of this task compiles. The audit that produced this plan read it from a slightly different point in time; verify against the live file rather than assuming.)

In `lib/attendance/sync.ts`, rewrite `findOrCreatePerson` to take a scoped client instance (not the plain admin client) so every lookup is club-filtered, and update `syncSessionAttendance` to build and pass that scoped client:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import type { Attendee } from "@/lib/eactivities/types";
import { escapeIlikePattern, normalizeCid } from "@/lib/utils";
import { reapplyWaiversForPerson } from "@/lib/purchase/interface";

// ... SessionNotBoundError / SyncDebouncedError / DEBOUNCE_MS / SyncResult unchanged ...

type ScopedClient = ReturnType<typeof createClubScopedClient>;

async function findOrCreatePerson(
  scoped: ScopedClient,
  attendee: Attendee,
  clubId: string
): Promise<{ id: string; created: boolean }> {
  const cid = attendee.CID ? normalizeCid(attendee.CID) : null;

  if (cid) {
    const { data: byCid } = await scoped
      .from("person")
      .select("id")
      .eq("cid", cid)
      .maybeSingle();
    if (byCid) return { id: byCid.id, created: false };
  }

  const email = attendee.Email.toLowerCase();
  const { data: byEmail } = await scoped
    .from("person")
    .select("id, cid")
    .ilike("email", escapeIlikePattern(email))
    .maybeSingle();
  if (byEmail) {
    if (cid && !byEmail.cid) {
      const { error: backfillError } = await scoped.from("person").update({ cid }).eq("id", byEmail.id);
      if (backfillError) throw backfillError;
    }
    return { id: byEmail.id, created: false };
  }

  const { data: created, error } = await scoped
    .from("person")
    .insert({
      cid,
      shortcode: attendee.Login,
      email: attendee.Email,
      full_name: `${attendee.FirstName} ${attendee.Surname}`.trim(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: created.id, created: true };
}

interface SyncOptions {
  provider?: Pick<EactivitiesProvider, "getSignup">;
}

export async function syncSessionAttendance(
  sessionId: string,
  clubId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const admin = createAdminClient();
  const scoped = createClubScopedClient(clubId);

  const { data: session, error: sessionError } = await scoped
    .from("session")
    .select("id, eactivities_signup_id, last_synced_at")
    .eq("id", sessionId)
    .single();
  if (sessionError) throw sessionError;
  if (!session.eactivities_signup_id) throw new SessionNotBoundError(sessionId);

  if (session.last_synced_at) {
    const elapsed = Date.now() - new Date(session.last_synced_at).getTime();
    if (elapsed < DEBOUNCE_MS) {
      throw new SyncDebouncedError(sessionId, DEBOUNCE_MS - elapsed);
    }
  }

  const provider = options.provider ?? new EactivitiesProvider();
  const signup = await provider.getSignup(session.eactivities_signup_id);

  let personsCreated = 0;
  let attendanceRecordsCreated = 0;

  for (const attendee of signup.Attendees) {
    const { id: personId, created } = await findOrCreatePerson(scoped, attendee, clubId);
    if (created) personsCreated += 1;

    const { data: inserted, error: insertError } = await scoped
      .from("attendance_record")
      .upsert(
        { person_id: personId, session_id: sessionId, source: "signup_sync" },
        { onConflict: "person_id,session_id", ignoreDuplicates: true }
      )
      .select("id");
    if (insertError) throw insertError;
    if (inserted && inserted.length > 0) {
      attendanceRecordsCreated += 1;
      await reapplyWaiversForPerson(personId);
    }
  }

  await scoped
    .from("session")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", sessionId);

  await scoped.from("sync_cursor").upsert({
    source: "eactivities",
    last_synced_at: new Date().toISOString(),
    last_synced_id: session.eactivities_signup_id,
  });

  return {
    attendeesSeen: signup.Attendees.length,
    personsCreated,
    attendanceRecordsCreated,
  };
}
```

Note `createAdminClient()` is no longer actually used in this file once every query is replaced with `scoped` — remove the now-unused `admin` variable and its import if `tsc`/eslint flags it as unused (check after this edit; some call sites above kept it only for illustration here).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/club-scoped-client.spec.ts tests/integration/attendance-sync.spec.ts`
Expected: PASS

- [ ] **Step 5: Update the remaining caller and commit**

`lib/attendance/sync.ts` is also called from `lib/attendance/actions.ts` (`createSessionFromSignup`'s best-effort initial sync, `triggerManualSync`) — those calls will fail to compile until Task 3 updates them. For this task, run `npx tsc --noEmit` and confirm the only new errors are in `lib/attendance/actions.ts` at the two `syncSessionAttendance(...)` call sites (Task 3 fixes these) — no errors anywhere else. Then commit:

```bash
git add lib/supabase/club-scoped.ts lib/attendance/sync.ts tests/integration/club-scoped-client.spec.ts tests/integration/attendance-sync.spec.ts
git commit -m "feat(attendance): scope findOrCreatePerson's lookups by club, thread clubId into syncSessionAttendance"
```

---

## Task 2: `lib/attendance/queries.ts` takes `clubId`; add `assertSessionBelongsToClub`

**Files:**
- Modify: `lib/attendance/queries.ts`
- Modify: `app/club/[clubSlug]/sessions/page.tsx`
- Modify: `app/club/[clubSlug]/sessions/[sessionId]/page.tsx`
- Test: `tests/integration/session-list.spec.ts`

**Interfaces:**
- Consumes: `createClubScopedClient(clubId)` from Task 1.
- Produces: `listRecentSessions(clubId: string)`, `getSessionWithAttendance(sessionId: string, clubId: string)` (both **signature changes** — `clubId` added), and a new `assertSessionBelongsToClub(sessionId: string, clubId: string): Promise<void>` that throws `SessionNotFoundError` (new exported class) if the session doesn't exist for that club. Task 3 consumes `assertSessionBelongsToClub`.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/session-list.spec.ts`, update every `listRecentSessions()` call to `listRecentSessions(judoClubId)` (9 call sites — the file already has `judoClubId` resolved in `test.beforeAll`). Then add a new test inside the `test.describe("listRecentSessions", ...)` block:

```ts
  test("never includes a session from a different club", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const { data: tkdSession, error } = await admin
      .from("session")
      .insert({ club_id: taekwondo!.id, title: "Taekwondo Isolation Test Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw error;

    const results = await listRecentSessions(judoClubId);
    expect(results.some((r) => r.id === tkdSession!.id)).toBe(false);

    await admin.from("session").delete().eq("id", tkdSession!.id);
  });
```

(This test cleans up inline because it's the only row it creates and the assertion that could fail — `results.some(...)` — can never throw; per the hardening convention this is still acceptable since there's no assertion between creation and cleanup that could leave it orphaned. If in doubt, prefer pushing `tkdSession!.id` onto a describe-level tracked array instead and deleting in the shared `afterEach` — do that if the reviewer flags it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/session-list.spec.ts`
Expected: FAIL to compile — `listRecentSessions` doesn't accept an argument yet.

- [ ] **Step 3: Implement**

```ts
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was not found for this club.`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Closes the toggle_attendance/by-id IDOR gap: that RPC (and several
 * Server Actions below it) take only a sessionId, with no club argument
 * of their own (Plan 2b-1 deliberately kept them row-scoped). Every
 * caller that accepts a sessionId from the client must call this first.
 */
export async function assertSessionBelongsToClub(sessionId: string, clubId: string): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped.from("session").select("id").eq("id", sessionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new SessionNotFoundError(sessionId);
}

export async function getSessionWithAttendance(
  sessionId: string,
  clubId: string
): Promise<SessionWithAttendance | null> {
  const scoped = createClubScopedClient(clubId);

  const { data: session, error: sessionError } = await scoped
    .from("session")
    .select("id, title, starts_at, eactivities_signup_id, last_synced_at, cancelled_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return null;

  const { data: records, error: recordsError } = await scoped
    .from("attendance_record")
    .select("id, attended, source, person:person_id(id, full_name, email)")
    .eq("session_id", sessionId);
  if (recordsError) throw recordsError;

  const attendance: AttendanceRow[] = (records ?? [])
    .map((record) => {
      const person = Array.isArray(record.person) ? record.person[0] : record.person;
      return {
        attendanceRecordId: record.id,
        personId: person.id,
        fullName: person.full_name,
        email: person.email,
        attended: record.attended,
        source: record.source,
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  return {
    id: session.id,
    title: session.title,
    startsAt: session.starts_at,
    eactivitiesSignupId: session.eactivities_signup_id,
    lastSyncedAt: session.last_synced_at,
    cancelledAt: session.cancelled_at,
    attendance,
  };
}

export async function listRecentSessions(clubId: string): Promise<SessionListItem[]> {
  const scoped = createClubScopedClient(clubId);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: sessions, error: sessionsError } = await scoped
    .from("session")
    .select("id, title, starts_at, cancelled_at")
    .gte("starts_at", thirtyDaysAgo)
    .or(`cancelled_at.is.null,cancelled_at.gt.${thirtyMinutesAgo}`)
    .order("starts_at", { ascending: false });
  if (sessionsError) throw sessionsError;

  const sessionIds = (sessions ?? []).map((s) => s.id);
  const countsBySessionId = new Map<string, number>();
  if (sessionIds.length > 0) {
    const { data: attendanceRows, error: attendanceError } = await scoped
      .from("attendance_record")
      .select("session_id")
      .eq("attended", true)
      .in("session_id", sessionIds)
      .range(0, 9999);
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
    isFuture: new Date(s.starts_at).getTime() > Date.now(),
    cancelledAt: s.cancelled_at,
  }));
}
```

Keep `isUtcToday`, the interfaces, and the doc comments from the existing file — only the two exported functions' bodies and signatures change, plus the two new exports (`SessionNotFoundError`, `assertSessionBelongsToClub`).

Update `app/club/[clubSlug]/sessions/page.tsx`:

```ts
  const { clubId } = await requireAdmin(clubSlug); // was: await requireAdmin(clubSlug); (discarded)
  // ...
  const [sessions, failedChaseCount] = await Promise.all([
    listRecentSessions(clubId),
    countFailedChaseEmails(clubId), // clubId arg added here too — see Task 10
  ]);
```

(The `countFailedChaseEmails(clubId)` half of this edit is Task 10's — for this task, leave that call as `countFailedChaseEmails()` and only change the `listRecentSessions` call; `tsc` will still pass since `countFailedChaseEmails` doesn't require an argument until Task 10 changes its signature.)

Update `app/club/[clubSlug]/sessions/[sessionId]/page.tsx`:

```ts
  const { clubId } = await requireAdmin(clubSlug);
  // ...
  const session = await getSessionWithAttendance(sessionId, clubId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/session-list.spec.ts && npx tsc --noEmit`
Expected: PASS. The only remaining `tsc` errors should be in `lib/attendance/actions.ts` (Task 3's `getAttendanceList`/`triggerManualSync` calls into these two functions) — confirm no other file breaks.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance/queries.ts app/club/\[clubSlug\]/sessions/page.tsx "app/club/[clubSlug]/sessions/[sessionId]/page.tsx" tests/integration/session-list.spec.ts
git commit -m "feat(attendance): scope listRecentSessions/getSessionWithAttendance by club, add assertSessionBelongsToClub"
```

---

## Task 3: `lib/attendance/actions.ts` — thread `clubId` through every by-id action

**Files:**
- Modify: `lib/attendance/actions.ts`
- Test: `tests/integration/attendance-toggle.spec.ts`

**Interfaces:**
- Consumes: `assertSessionBelongsToClub`, `getSessionWithAttendance(sessionId, clubId)` (Task 2); `syncSessionAttendance(sessionId, clubId, options?)` (Task 1); `createClubScopedClient` (Task 1).
- Produces: every exported Server Action in this file keeps its existing `(clubSlug, ...)` public signature (no caller-facing change — the client components that call these don't change at all) but now actually uses the `clubId` `requireAdmin` already returns, instead of discarding it or calling `getDefaultClubId`.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/attendance-toggle.spec.ts`, a new top-level test (outside the existing `test.describe`, since it needs a second club's data and the existing describe's `beforeEach`/`afterEach` only track one person/session):

```ts
test.describe("toggle_attendance cross-club safety (app-layer check)", () => {
  test("assertSessionBelongsToClub rejects a session from a different club", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const { data: tkdSession, error } = await admin
      .from("session")
      .insert({ club_id: taekwondo!.id, title: "Cross-Club IDOR Test Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw error;

    const { assertSessionBelongsToClub, SessionNotFoundError } = await import("@/lib/attendance/queries");
    await expect(assertSessionBelongsToClub(tkdSession!.id, judoClubId)).rejects.toThrow(SessionNotFoundError);

    await admin.from("session").delete().eq("id", tkdSession!.id);
  });
});
```

This directly exercises the helper `toggleAttendance` and friends will call — it's the testable seam, since the Server Actions themselves need a real request context (same limitation `chase-approval.spec.ts` documents).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/attendance-toggle.spec.ts`
Expected: FAIL — `assertSessionBelongsToClub`/`SessionNotFoundError` don't exist yet if Task 2 hasn't landed first in this run, or PASS already if Task 2 is done (this task assumes Task 2 is complete; if this test already passes at Step 2, that's fine — skip to wiring the actions in Step 3, which is this task's actual deliverable).

- [ ] **Step 3: Implement**

Rewrite `lib/attendance/actions.ts`'s by-id actions. Full new content for the file (keep the imports/schemas that don't change; this shows every function body that does):

```ts
"use server";

import { z } from "zod";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import { syncSessionAttendance } from "@/lib/attendance/sync";
import { getSessionWithAttendance, assertSessionBelongsToClub } from "@/lib/attendance/queries";
import { requireAdmin } from "@/lib/auth/require-admin";
import { escapeIlikePattern, normalizeCid } from "@/lib/utils";
import { reapplyWaiversForPerson } from "@/lib/purchase/interface";

const provider = new EactivitiesProvider();

// ... getEventSignups unchanged ...

export async function createSessionFromSignup(
  clubSlug: string,
  input: z.infer<typeof createSessionSchema>
): Promise<{ sessionId: string }> {
  const { clubId } = await requireAdmin(clubSlug);
  const gate = process.env.EACTIVITIES_CLUB_SLUG;
  if (gate && clubSlug !== gate) {
    throw new Error("eActivities isn't available for this club yet — use CSV import instead.");
  }
  const parsed = createSessionSchema.parse(input);
  const scoped = createClubScopedClient(clubId);

  const { data: session, error } = await scoped
    .from("session")
    .insert({
      eactivities_event_id: parsed.eventId,
      eactivities_signup_id: parsed.signupId,
      title: parsed.title,
      starts_at: new Date(parsed.startsAt).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;

  try {
    await syncSessionAttendance(session.id, clubId);
  } catch {
    // swallow — non-fatal, see comment in the original
  }

  return { sessionId: session.id };
}

export async function toggleAttendance(clubSlug: string, input: z.infer<typeof toggleSchema>) {
  const { clubId } = await requireAdmin(clubSlug);
  const { sessionId, personId, attended } = toggleSchema.parse(input);
  await assertSessionBelongsToClub(sessionId, clubId);
  const scoped = createClubScopedClient(clubId);

  const { error } = await scoped.rpc("toggle_attendance", {
    target_person_id: personId,
    target_session_id: sessionId,
    target_attended: attended,
  });
  if (error) throw error;

  if (attended) {
    await reapplyWaiversForPerson(personId);
  }
}

export async function setSessionCancelled(
  clubSlug: string,
  input: z.infer<typeof setSessionCancelledSchema>
) {
  const { clubId } = await requireAdmin(clubSlug);
  const { sessionId, cancelled } = setSessionCancelledSchema.parse(input);
  const scoped = createClubScopedClient(clubId);

  const { error } = await scoped
    .from("session")
    .update({ cancelled_at: cancelled ? new Date().toISOString() : null })
    .eq("id", sessionId);
  if (error) throw error;
}

// ... searchPeople unchanged (already correctly scoped) ...

export async function addExistingPersonToSession(clubSlug: string, sessionId: string, personId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  await assertSessionBelongsToClub(sessionId, clubId);
  const scoped = createClubScopedClient(clubId);
  const { error } = await scoped.from("attendance_record").upsert(
    { person_id: personId, session_id: sessionId, attended: true, source: "manual_tick" },
    { onConflict: "person_id,session_id" }
  );
  if (error) throw error;

  await reapplyWaiversForPerson(personId);
}

export async function createWalkIn(
  clubSlug: string,
  input: z.infer<typeof walkInSchema>
): Promise<{ personId: string; reusedExisting: boolean }> {
  const { clubId } = await requireAdmin(clubSlug);
  const { sessionId, email, fullName, cid: rawCid } = walkInSchema.parse(input);
  await assertSessionBelongsToClub(sessionId, clubId);
  const cid = rawCid ? normalizeCid(rawCid) : null;
  const scoped = createClubScopedClient(clubId);

  let existing: { id: string; cid: string | null } | null = null;
  if (cid) {
    const { data, error } = await scoped.from("person").select("id, cid").eq("cid", cid).maybeSingle();
    if (error) throw error;
    existing = data;
  }
  if (!existing) {
    const { data, error } = await scoped
      .from("person")
      .select("id, cid")
      .ilike("email", escapeIlikePattern(email))
      .maybeSingle();
    if (error) throw error;
    existing = data;
  }

  let personId: string;
  if (existing) {
    personId = existing.id;
    if (cid && !existing.cid) {
      const { error: backfillError } = await scoped.from("person").update({ cid }).eq("id", existing.id);
      if (backfillError) throw backfillError;
    }
  } else {
    const { data: person, error: personError } = await scoped
      .from("person")
      .insert({ email, full_name: fullName, cid, identity_confidence: "provisional" })
      .select("id")
      .single();
    if (personError) throw personError;
    personId = person.id;
  }

  const { error: attendanceError } = await scoped.from("attendance_record").upsert(
    { person_id: personId, session_id: sessionId, attended: true, source: existing ? "manual_tick" : "walk_in" },
    { onConflict: "person_id,session_id" }
  );
  if (attendanceError) throw attendanceError;

  await reapplyWaiversForPerson(personId);

  return { personId, reusedExisting: !!existing };
}

export async function triggerManualSync(clubSlug: string, sessionId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  await assertSessionBelongsToClub(sessionId, clubId);
  return syncSessionAttendance(sessionId, clubId);
}

export async function getAttendanceList(clubSlug: string, sessionId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  const session = await getSessionWithAttendance(sessionId, clubId);
  return session?.attendance ?? [];
}
```

Note `createAdminClient`/`getDefaultClubId` imports are now unused in this file — remove them.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/attendance-toggle.spec.ts tests/integration/attendance-sync.spec.ts tests/integration/session-list.spec.ts && npx tsc --noEmit`
Expected: PASS. Confirm `getDefaultClubId` no longer appears in this file: `grep -n getDefaultClubId lib/attendance/actions.ts` should return nothing.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance/actions.ts tests/integration/attendance-toggle.spec.ts
git commit -m "feat(attendance): thread real clubId through every by-id Server Action, close the toggle_attendance IDOR"
```

---

## Task 4: CSV import — `findOrCreatePersonByEmail`, `importAttendanceCsv`, `syncAttendanceCsv`

**Files:**
- Modify: `lib/csv-import/importer.ts`
- Modify: `lib/csv-import/actions.ts`
- Test: `tests/integration/csv-import.spec.ts`

**Interfaces:**
- Consumes: `createClubScopedClient` (Task 1), `assertSessionBelongsToClub` (Task 2).
- Produces: `importAttendanceCsv(input, clubId)`, `syncAttendanceCsv(input, clubId)` (**signature change**: `clubId` added as a second parameter, since `input` is already a structured object per-function and adding a field to it would force every existing call site to spread one more key — a trailing parameter is the smaller diff and matches `findOrCreatePerson`'s existing convention of `clubId` last).

- [ ] **Step 1: Write the failing tests**

In `tests/integration/csv-import.spec.ts`, update all 9 `importAttendanceCsv({...})` / `syncAttendanceCsv({...})` call sites to pass `judoClubId` as the second argument, e.g. `importAttendanceCsv({ title: ..., startsAt: ..., rows }, judoClubId)`. Then add, inside `test.describe("importAttendanceCsv", ...)`:

```ts
  test("never matches an existing person from a different club, even with the same email", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const sharedEmail = `csv-import-cross-club-${crypto.randomUUID()}@example.test`;
    const { data: tkdPerson, error } = await admin
      .from("person")
      .insert({ club_id: taekwondo!.id, full_name: "Taekwondo Person", email: sharedEmail })
      .select("id")
      .single();
    if (error) throw error;

    const result = await importAttendanceCsv(
      { title: "CSV Cross-Club Test", startsAt: "2026-10-15T18:00:00.000Z", rows: [row({ email: sharedEmail })] },
      judoClubId
    );
    sessionIds.push(result.sessionId);

    const { data: record } = await admin
      .from("attendance_record")
      .select("person_id, person:person_id(club_id)")
      .eq("session_id", result.sessionId)
      .single();
    const person = Array.isArray(record!.person) ? record!.person[0] : record!.person;
    expect(person.club_id).toBe(judoClubId); // a NEW Judo person, not the Taekwondo one
    personIds.push(record!.person_id);

    await admin.from("person").delete().eq("id", tkdPerson!.id);
  });
```

And inside `test.describe("syncAttendanceCsv", ...)`, update the `newSession()` helper and every `syncAttendanceCsv({...})` call to pass `judoClubId`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/csv-import.spec.ts`
Expected: FAIL to compile — neither function accepts a second argument yet.

- [ ] **Step 3: Implement**

```ts
import { z } from "zod";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { escapeIlikePattern, normalizeCid } from "@/lib/utils";
import type { AttendeeRow } from "./parser";

export const createSessionFromCsvSchema = z.object({
  title: z.string().min(1).max(200),
  startsAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
});

export interface ImportAttendanceCsvInput {
  title: string;
  startsAt: string;
  rows: AttendeeRow[];
}

export interface ImportAttendanceCsvResult {
  sessionId: string;
  imported: number;
}

type ScopedClient = ReturnType<typeof createClubScopedClient>;

async function findOrCreatePersonByEmail(scoped: ScopedClient, row: AttendeeRow): Promise<string> {
  const email = row.email.toLowerCase();
  const cid = row.rawCidOrCardNumber ? normalizeCid(row.rawCidOrCardNumber) : null;

  if (cid) {
    const { data: byCid, error: cidLookupError } = await scoped
      .from("person")
      .select("id")
      .eq("cid", cid)
      .maybeSingle();
    if (cidLookupError) throw cidLookupError;
    if (byCid) return byCid.id;
  }

  const { data: byEmail, error: emailLookupError } = await scoped
    .from("person")
    .select("id, cid")
    .ilike("email", escapeIlikePattern(email))
    .maybeSingle();
  if (emailLookupError) throw emailLookupError;

  if (byEmail) {
    if (cid && !byEmail.cid) {
      const { error: backfillError } = await scoped.from("person").update({ cid }).eq("id", byEmail.id);
      if (backfillError) throw backfillError;
    }
    return byEmail.id;
  }

  const { data: created, error: personError } = await scoped
    .from("person")
    .insert({
      email: row.email,
      full_name: `${row.firstName} ${row.surname}`.trim(),
      identity_confidence: "confirmed",
      cid,
    })
    .select("id")
    .single();
  if (personError) throw personError;
  return created.id;
}

export async function importAttendanceCsv(
  input: ImportAttendanceCsvInput,
  clubId: string
): Promise<ImportAttendanceCsvResult> {
  const scoped = createClubScopedClient(clubId);

  const { data: session, error: sessionError } = await scoped
    .from("session")
    .insert({ title: input.title, starts_at: new Date(input.startsAt).toISOString() })
    .select("id")
    .single();
  if (sessionError) throw sessionError;

  for (const row of input.rows) {
    const personId = await findOrCreatePersonByEmail(scoped, row);

    const { error: attendanceError } = await scoped.from("attendance_record").insert({
      person_id: personId,
      session_id: session.id,
      source: "csv_import",
      attended: false,
      raw_cid_or_card_number: row.rawCidOrCardNumber,
    });
    if (attendanceError) throw attendanceError;
  }

  return { sessionId: session.id, imported: input.rows.length };
}

export interface SyncAttendanceCsvInput {
  sessionId: string;
  rows: AttendeeRow[];
}

export interface SyncAttendanceCsvResult {
  added: number;
  skipped: number;
  removed: number;
}

export async function syncAttendanceCsv(
  input: SyncAttendanceCsvInput,
  clubId: string
): Promise<SyncAttendanceCsvResult> {
  const scoped = createClubScopedClient(clubId);

  const records = [];
  for (const row of input.rows) {
    const personId = await findOrCreatePersonByEmail(scoped, row);
    records.push({
      person_id: personId,
      session_id: input.sessionId,
      source: "csv_import" as const,
      attended: false,
      raw_cid_or_card_number: row.rawCidOrCardNumber,
    });
  }

  const { data: upserted, error: upsertError } = await scoped
    .from("attendance_record")
    .upsert(records, { onConflict: "person_id,session_id", ignoreDuplicates: true })
    .select("id");
  if (upsertError) throw upsertError;
  const added = upserted?.length ?? 0;

  const newEmails = new Set(input.rows.map((row) => row.email.toLowerCase()));

  const { data: existingCsvRows, error: existingError } = await scoped
    .from("attendance_record")
    .select("id, person:person_id(email)")
    .eq("session_id", input.sessionId)
    .eq("source", "csv_import")
    .eq("attended", false);
  if (existingError) throw existingError;

  const idsToRemove = (existingCsvRows ?? [])
    .filter((record) => {
      const person = Array.isArray(record.person) ? record.person[0] : record.person;
      return !newEmails.has(person.email.toLowerCase());
    })
    .map((record) => record.id);

  let removed = 0;
  if (idsToRemove.length > 0) {
    const { error: deleteError, count } = await scoped
      .from("attendance_record")
      .delete({ count: "exact" })
      .in("id", idsToRemove);
    if (deleteError) throw deleteError;
    removed = count ?? idsToRemove.length;
  }

  return { added, skipped: input.rows.length - added, removed };
}
```

Update `lib/csv-import/actions.ts`'s two callers:

```ts
export async function createSessionFromCsv(clubSlug: string, formData: FormData): Promise<CreateSessionFromCsvResult> {
  const { clubId } = await requireAdmin(clubSlug);
  // ... unchanged parsing ...
  try {
    const result = await importAttendanceCsv(
      { title: parsed.data.title, startsAt: parsed.data.startsAt, rows },
      clubId
    );
    // ... unchanged ...
  }
  // ...
}

export async function syncCsvToSession(clubSlug: string, sessionId: string, formData: FormData): Promise<SyncCsvToSessionResult> {
  const { clubId } = await requireAdmin(clubSlug);
  await assertSessionBelongsToClub(sessionId, clubId);
  // ... unchanged parsing ...
  try {
    const result = await syncAttendanceCsv({ sessionId: parsedSessionId.data, rows }, clubId);
    // ... unchanged ...
  }
  // ...
}
```

Add the `assertSessionBelongsToClub` import at the top of `actions.ts`: `import { assertSessionBelongsToClub } from "@/lib/attendance/queries";`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/csv-import.spec.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/csv-import/importer.ts lib/csv-import/actions.ts tests/integration/csv-import.spec.ts
git commit -m "feat(csv-import): scope findOrCreatePersonByEmail/importAttendanceCsv/syncAttendanceCsv by club"
```

---

## Task 5: `lib/purchase/matcher.ts` — scope `matchPersonRecord`/`matchOrQueue`

**Files:**
- Modify: `lib/purchase/matcher.ts`
- Test: `tests/integration/purchase-matcher.spec.ts`

**Interfaces:**
- Produces: `matchPersonRecord(row, clubId)`, `matchOrQueue(rows, clubId)` (**signature change**: `clubId` added as the last parameter to both, consistent with the file's existing single-responsibility match rules).

- [ ] **Step 1: Write the failing test**

Update all 5 existing `matchPersonRecord(row({...}))` call sites in `tests/integration/purchase-matcher.spec.ts` to `matchPersonRecord(row({...}), judoClubId)` (read the file's existing `test.beforeAll` to confirm the exact variable name it resolves Judo's id into — audit found the repo-wide convention is `judoClubId`; use whatever this specific file already uses if it differs). Add a new test:

```ts
test("a CID match never crosses club boundaries, even when the CID string is identical", async () => {
  const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  const sharedCid = String(Math.floor(10_000_000 + Math.random() * 80_000_000));
  const { data: tkdPerson, error } = await admin
    .from("person")
    .insert({ club_id: taekwondo!.id, full_name: "Taekwondo CID Person", email: `tkd-matcher-${crypto.randomUUID()}@example.test`, cid: sharedCid })
    .select("id")
    .single();
  if (error) throw error;

  const result = await matchPersonRecord(
    row({ personCid: sharedCid, memberType: "Student", personName: "Judo Buyer" }),
    judoClubId
  );
  expect(result).toEqual({ matchStatus: "unmatched" }); // the CID exists, but only in Taekwondo

  await admin.from("person").delete().eq("id", tkdPerson!.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-matcher.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```ts
import { createClubScopedClient } from '@/lib/supabase/club-scoped';
import { RawPurchaseRow, MatchResult, isStudentMemberType } from './types';
import { escapeIlikePattern, normalizeCid } from '@/lib/utils';

export async function matchPersonRecord(row: RawPurchaseRow, clubId: string): Promise<MatchResult> {
  const scoped = createClubScopedClient(clubId);

  if (row.personCid) {
    const { data } = await scoped
      .from('person')
      .select('id')
      .eq('cid', normalizeCid(row.personCid))
      .maybeSingle();

    if (data) {
      return { personId: data.id, matchStatus: 'cid_matched' };
    }
  }

  if (row.personCid && isStudentMemberType(row.memberType)) {
    return { matchStatus: 'unmatched' };
  }

  if (row.personEmail) {
    const { data } = await scoped
      .from('person')
      .select('id')
      .ilike('email', escapeIlikePattern(row.personEmail))
      .maybeSingle();

    if (data) {
      return { personId: data.id, matchStatus: 'email_matched' };
    }
  }

  if (row.personName) {
    const { data } = await scoped
      .from('person')
      .select('id')
      .ilike('full_name', escapeIlikePattern(row.personName.trim()));

    if (data && data.length === 1) {
      return { personId: data[0].id, matchStatus: 'name_matched' };
    }
  }

  return { matchStatus: 'unmatched' };
}

export async function matchOrQueue(
  rows: RawPurchaseRow[],
  clubId: string
): Promise<{ matched: Map<string, MatchResult>; unmatched: RawPurchaseRow[] }> {
  const matched = new Map<string, MatchResult>();
  const unmatched: RawPurchaseRow[] = [];

  for (const row of rows) {
    const result = await matchPersonRecord(row, clubId);
    if (result.matchStatus === 'unmatched') {
      unmatched.push(row);
    } else {
      matched.set(row.externalId, result);
    }
  }

  return { matched, unmatched };
}
```

Note: `createClubScopedClient`'s `select()` wrapper always appends `.eq("club_id", clubId)` (see `lib/supabase/club-scoped.ts`), so the `ilike('full_name', ...)` ambiguous-name check (Rule 4) is now also correctly scoped — two same-named people in *different* clubs no longer count as ambiguous against each other, only two same-named people within the *same* club do. This is a behavior improvement the design doc didn't call out explicitly but follows directly from the club-scoped client — no extra code needed, just confirm it with the Review Focus test above (a same-named Taekwondo person must not make an otherwise-unambiguous Judo name look ambiguous; add this as a second new test if the task reviewer flags it as uncovered).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-matcher.spec.ts && npx tsc --noEmit`
Expected: FAIL (compile errors) at every remaining caller of `matchPersonRecord`/`matchOrQueue` outside this file and its test — confirm the only failures are in `lib/purchase/interface.ts` (Tasks 6-7 fix these).

- [ ] **Step 5: Commit**

```bash
git add lib/purchase/matcher.ts tests/integration/purchase-matcher.spec.ts
git commit -m "feat(purchase): scope matchPersonRecord/matchOrQueue by club"
```

---

## Task 6: `ingestPurchases` takes `clubId`

**Files:**
- Modify: `lib/purchase/interface.ts` (this task touches only `ingestPurchases`; Task 7 touches the rest of this file)
- Modify: `lib/xlsx/uploader.ts`
- Test: `tests/integration/ingest-purchases.spec.ts`

**Interfaces:**
- Consumes: `matchOrQueue(rows, clubId)` (Task 5).
- Produces: `ingestPurchases(rows, clubId)` (**signature change** — `clubId` added as a second parameter).

- [ ] **Step 1: Write the failing test**

Update every `ingestPurchases([...])` call site in `tests/integration/ingest-purchases.spec.ts` to `ingestPurchases([...], judoClubId)` — there are 6 such sites across the `ingestPurchases` describe block (the "two different clubs" test from the just-merged hardening work already resolves `judo`/`taekwondo` ids locally; pass `judo!.id` there specifically, not the outer `judoClubId`, since that test is explicitly cross-club). Add a new test:

```ts
test("a row whose CID matches a person in a different club is ingested unmatched, not cross-matched", async () => {
  const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  const cid = String(Math.floor(10_000_000 + Math.random() * 80_000_000));
  const { data: tkdPerson, error } = await admin
    .from("person")
    .insert({ club_id: taekwondo!.id, full_name: "Taekwondo Buyer", email: `tkd-ingest-${crypto.randomUUID()}@example.test`, cid })
    .select("id")
    .single();
  if (error) throw error;

  const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
  const product = await admin
    .from("product")
    .insert({ club_id: judo!.id, name: `Cross-Club Ingest Test ${crypto.randomUUID()}`, kind: "other" })
    .select("id")
    .single();
  productId = product.data!.id;

  const result = await ingestPurchases(
    [
      {
        externalId: `ext-cross-club-${crypto.randomUUID()}`,
        personName: "Someone Else",
        personCid: cid,
        memberType: "Public", // non-student, so Rule 2's "no fallback" doesn't apply -- isolates the CID check
        productId,
        purchasedAt: new Date(),
        source: "pluto_api",
      },
    ],
    judo!.id
  );
  expect(result.inserted).toBe(1);

  const { data: purchase } = await admin
    .from("purchase")
    .select("match_status, person_id")
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  expect(purchase!.match_status).toBe("unmatched");
  expect(purchase!.person_id).toBeNull();

  await admin.from("person").delete().eq("id", tkdPerson!.id);
});
```

(This reuses the describe block's existing `productId` tracked variable — per the hardening work from the prior session, its `afterEach` already deletes `purchase` by `product_id` before the `product` row, so no extra cleanup is needed here beyond the inline Taekwondo person delete, which has no fallible assertion after it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/ingest-purchases.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

In `lib/purchase/interface.ts`, change only `ingestPurchases`'s signature and body (the rest of the file is Task 7's):

```ts
import { createAdminClient } from '@/lib/supabase/admin';
import { createClubScopedClient } from '@/lib/supabase/club-scoped';
import { RawPurchaseRow, PurchaseRecord, IngestionResult, IngestionError, isStudentMemberType } from './types';
import { matchOrQueue, matchPersonRecord } from './matcher';
import { z } from 'zod';

// ... rawPurchaseRowSchema unchanged ...

export async function ingestPurchases(rows: RawPurchaseRow[], clubId: string): Promise<IngestionResult> {
  const scoped = createClubScopedClient(clubId);
  const errors: IngestionError[] = [];

  const validRows: RawPurchaseRow[] = [];
  for (const row of rows) {
    const parsed = rawPurchaseRowSchema.safeParse(row);
    if (parsed.success) {
      validRows.push(row);
    } else {
      errors.push({
        rowId: row.externalId,
        reason: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
        rawRow: row,
      });
    }
  }

  if (validRows.length === 0) {
    return { inserted: 0, duplicates: 0, errors };
  }

  let matched: Map<string, import('./types').MatchResult>;
  try {
    ({ matched } = await matchOrQueue(validRows, clubId));
  } catch (error) {
    matched = new Map();
    console.warn('matchOrQueue threw; treating all rows as unmatched for this batch:', error);
  }

  const productMap = new Map<string, string>();
  const uniqueProductNames = [
    ...new Set(validRows.filter((row) => !row.productId && row.productName).map((row) => row.productName!)),
  ];

  for (const productName of uniqueProductNames) {
    try {
      const { data: upserted, error: upsertError } = await scoped
        .from('product')
        .upsert({ name: productName, kind: 'other' }, { onConflict: 'club_id,name', ignoreDuplicates: true })
        .select('id')
        .maybeSingle();

      if (upsertError) {
        console.warn(`Product upsert failed for "${productName}":`, upsertError.message);
        continue;
      }

      if (upserted) {
        productMap.set(productName, upserted.id);
        continue;
      }

      const { data: existing, error: lookupError } = await scoped
        .from('product')
        .select('id')
        .eq('name', productName)
        .maybeSingle();

      if (!lookupError && existing) {
        productMap.set(productName, existing.id);
      } else if (lookupError) {
        console.warn(`Product lookup failed for "${productName}":`, lookupError.message);
      }
    } catch (error) {
      console.warn(`Product resolution threw for "${productName}":`, error);
    }
  }

  const purchases: (PurchaseRecord & { sourceRowId: string })[] = [];

  for (const row of validRows) {
    const productId = row.productId ?? productMap.get(row.productName!);
    if (!productId) {
      errors.push({ rowId: row.externalId, reason: `Could not resolve or create product "${row.productName}"`, rawRow: row });
      continue;
    }

    const matchResult = matched.get(row.externalId);
    const isStudent = isStudentMemberType(row.memberType);

    purchases.push({
      personId: matchResult?.personId ?? null,
      productId,
      uploadId: row.uploadId ?? null,
      source: row.source,
      sourceRowId: row.externalId,
      rawMemberType: row.memberType,
      rawPersonName: row.personName,
      rawEmail: row.personEmail ?? null,
      rawCid: row.personCid ?? null,
      isStudent,
      matchStatus: matchResult?.matchStatus ?? 'unmatched',
      purchasedAt: row.purchasedAt,
    });
  }

  const latestByPerson = new Map<string, (typeof purchases)[number]>();
  for (const purchase of purchases) {
    if (!purchase.personId) continue;
    const current = latestByPerson.get(purchase.personId);
    if (!current || purchase.purchasedAt > current.purchasedAt) {
      latestByPerson.set(purchase.personId, purchase);
    }
  }

  let inserted = 0;
  let duplicates = 0;

  for (const purchase of purchases) {
    try {
      const { data: insertedPurchase, error } = await scoped
        .from('purchase')
        .insert({
          person_id: purchase.personId,
          product_id: purchase.productId,
          upload_id: purchase.uploadId,
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

      if (error) {
        if (error.code === '23505') {
          duplicates++;
        } else {
          errors.push({ rowId: purchase.sourceRowId, reason: error.message, rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)! });
        }
      } else {
        inserted++;

        if (purchase.personId && latestByPerson.get(purchase.personId) === purchase) {
          const { error: updateError } = await scoped.from('person').update({ is_student: purchase.isStudent }).eq('id', purchase.personId);
          if (updateError) {
            errors.push({ rowId: purchase.sourceRowId, reason: `Purchase inserted, but failed to update person.is_student: ${updateError.message}`, rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)! });
          }
        }

        if (purchase.personId && insertedPurchase) {
          try {
            await applyWaivers(purchase.personId, insertedPurchase.id);
          } catch (waiverError) {
            errors.push({ rowId: purchase.sourceRowId, reason: `Purchase inserted, but waiver assignment failed: ${waiverError instanceof Error ? waiverError.message : 'unknown error'}`, rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)! });
          }
        }
      }
    } catch (error) {
      errors.push({ rowId: purchase.sourceRowId, reason: error instanceof Error ? error.message : 'Unexpected error during insert', rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)! });
    }
  }

  return { inserted, duplicates, errors };
}

// applyWaivers / reapplyWaiversForPerson / reapplyWaiversForEveryoneWithDebt /
// rematchUnmatchedPurchases / listRecentUploads / changeUploadProduct /
// undoUpload are UNCHANGED in this task -- see Task 7.
```

Update `lib/xlsx/uploader.ts`'s call site (the only production caller of `ingestPurchases`):

```ts
  const result = await ingestPurchases(
    rows.map((row) => ({ ...row, uploadId: upload.id })),
    adminUser.clubId
  );
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/ingest-purchases.spec.ts && npx tsc --noEmit`
Expected: PASS for the test file; `tsc` should show no new errors in `lib/xlsx/uploader.ts` and only pre-existing ones (from Task 7's not-yet-done work) elsewhere in `lib/purchase/interface.ts`'s own file, if any surface from the partial edit — there shouldn't be any, since this task only touched `ingestPurchases`.

- [ ] **Step 5: Commit**

```bash
git add lib/purchase/interface.ts lib/xlsx/uploader.ts tests/integration/ingest-purchases.spec.ts
git commit -m "feat(purchase): scope ingestPurchases by club"
```

---

## Task 7: `lib/purchase/interface.ts` — the rest of the file

**Files:**
- Modify: `lib/purchase/interface.ts`
- Modify: `lib/purchase/actions.ts`
- Test: `tests/integration/purchase-upload.spec.ts`, `tests/integration/purchase-waivers.spec.ts`

**Interfaces:**
- Consumes: `matchPersonRecord(row, clubId)` (Task 5), `createClubScopedClient` (Task 1).
- Produces: `rematchUnmatchedPurchases(clubId)`, `listRecentUploads(clubId, limit?)` (clubId moved to first positional, since `limit` already has a default — matches the existing `limit = 5` default convention cleanly), `changeUploadProduct(clubId, uploadId, newProductId)`, `undoUpload(clubId, uploadId)`, `reapplyWaiversForEveryoneWithDebt(clubId)` (all **signature changes**). `applyWaivers`/`reapplyWaiversForPerson` are unchanged — they're already row-scoped RPCs with no club argument by design (Plan 2b-1), and every caller already holds a `personId`/`purchaseId` it independently verified belongs to the right club.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/purchase-upload.spec.ts`: this file's own `test.afterEach` already tracks `productIds`/`uploadIds`/`purchaseIds`/`sessionIds`/`personId` at the describe level (from the just-merged hardening work) — no helper function signatures in that file call `changeUploadProduct`/`undoUpload`/`listRecentUploads` directly today (confirm with a search); its 4 existing tests call the higher-level helpers `createUpload`/`createPurchase` it defines itself, plus `listRecentUploads`, `changeUploadProduct`, `undoUpload` which ARE imported at the top from `@/lib/purchase/interface` — update those 3 call sites to pass `judoClubId` as the first argument (e.g. `listRecentUploads(judoClubId, 5)`, `changeUploadProduct(judoClubId, uploadId, rightProduct)`, `undoUpload(judoClubId, uploadId)`). Add a new test:

```ts
  test("changeUploadProduct refuses a newProductId that belongs to a different club", async () => {
    personId = await createPerson();
    const product = await createProduct(1);
    const uploadId = await createUpload(product);

    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const { data: tkdProduct, error } = await admin
      .from("product")
      .insert({ club_id: taekwondo!.id, name: `Cross-Club Product ${crypto.randomUUID()}`, kind: "other" })
      .select("id")
      .single();
    if (error) throw error;

    await expect(changeUploadProduct(judoClubId, uploadId, tkdProduct!.id)).rejects.toThrow();

    await admin.from("product").delete().eq("id", tkdProduct!.id);
  });
```

In `tests/integration/purchase-waivers.spec.ts`, update the single `reapplyWaiversForEveryoneWithDebt()` call site to `reapplyWaiversForEveryoneWithDebt(judoClubId)` (confirm the exact local variable name this file resolves Judo's id into via its own `beforeAll`/setup — read the file first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-upload.spec.ts tests/integration/purchase-waivers.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

Replace the remaining exports in `lib/purchase/interface.ts` (everything after `ingestPurchases`, which Task 6 already changed):

```ts
export async function applyWaivers(personId: string, purchaseId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('apply_purchase_waiver', { target_purchase_id: purchaseId });
  if (error) throw new Error(`Failed to apply waiver for purchase ${purchaseId} (person ${personId}): ${error.message}`);
  return data ?? 0;
}

export async function reapplyWaiversForPerson(personId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('reapply_waivers_for_person', { target_person_id: personId });
  if (error) throw new Error(`Failed to reapply waivers for person ${personId}: ${error.message}`);
  return data ?? 0;
}

export interface ReapplySweepResult {
  peopleChecked: number;
  totalWaived: number;
}

export async function reapplyWaiversForEveryoneWithDebt(clubId: string): Promise<ReapplySweepResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('reapply_waivers_for_everyone_with_debt', { target_club_id: clubId });
  if (error) throw new Error(`Failed to run the waiver re-check sweep: ${error.message}`);

  const rows = (data ?? []) as { person_id: string; waived: number }[];
  const totalWaived = rows.reduce((sum, row) => sum + row.waived, 0);
  return { peopleChecked: rows.length, totalWaived };
}

export interface RematchResult {
  matched: number;
  stillUnmatched: number;
}

export async function rematchUnmatchedPurchases(clubId: string): Promise<RematchResult> {
  const scoped = createClubScopedClient(clubId);

  const { data: unmatched, error } = await scoped
    .from('purchase')
    .select('id, raw_person_name, raw_cid, raw_email, raw_member_type, purchased_at')
    .eq('match_status', 'unmatched');
  if (error) throw error;

  let matched = 0;
  let stillUnmatched = 0;

  for (const p of unmatched ?? []) {
    const row: RawPurchaseRow = {
      externalId: p.id,
      personName: p.raw_person_name,
      personEmail: p.raw_email ?? undefined,
      personCid: p.raw_cid ?? undefined,
      memberType: p.raw_member_type ?? '',
      productId: 'unused',
      purchasedAt: new Date(p.purchased_at),
      source: 'xlsx_upload',
    };

    const result = await matchPersonRecord(row, clubId);
    if (result.matchStatus === 'unmatched') {
      stillUnmatched++;
      continue;
    }

    const { error: updateError } = await scoped
      .from('purchase')
      .update({ person_id: result.personId, match_status: result.matchStatus })
      .eq('id', p.id);
    if (updateError) throw updateError;

    await applyWaivers(result.personId!, p.id);
    matched++;
  }

  return { matched, stillUnmatched };
}

export interface UploadBatch {
  id: string;
  productId: string;
  productName: string;
  filename: string | null;
  rowCount: number;
  uploadedBy: string | null;
  createdAt: string;
}

export async function listRecentUploads(clubId: string, limit = 5): Promise<UploadBatch[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from('purchase_upload')
    .select('id, product_id, filename, row_count, uploaded_by, created_at, product:product_id(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((u) => {
    const product = Array.isArray(u.product) ? u.product[0] : u.product;
    return {
      id: u.id,
      productId: u.product_id,
      productName: product?.name ?? 'Unknown product',
      filename: u.filename,
      rowCount: u.row_count,
      uploadedBy: u.uploaded_by,
      createdAt: u.created_at,
    };
  });
}

export async function changeUploadProduct(
  clubId: string,
  uploadId: string,
  newProductId: string
): Promise<{ purchasesUpdated: number; rewaived: number }> {
  const scoped = createClubScopedClient(clubId);

  // The new product must belong to this club too -- scoped select returns
  // null for a cross-club id, same mechanism as every other guard in this
  // sweep.
  const { data: product, error: productError } = await scoped.from('product').select('id').eq('id', newProductId).maybeSingle();
  if (productError) throw productError;
  if (!product) throw new Error(`Product ${newProductId} does not belong to this club.`);

  const { data: purchases, error } = await scoped.from('purchase').select('id, person_id').eq('upload_id', uploadId);
  if (error) throw error;
  if (!purchases || purchases.length === 0) {
    return { purchasesUpdated: 0, rewaived: 0 };
  }

  const purchaseIds = purchases.map((p) => p.id);

  const { error: unwaiveError } = await scoped
    .from('attendance_record')
    .update({ waived_by_purchase_id: null })
    .in('waived_by_purchase_id', purchaseIds);
  if (unwaiveError) throw unwaiveError;

  const { error: updatePurchasesError } = await scoped.from('purchase').update({ product_id: newProductId }).eq('upload_id', uploadId);
  if (updatePurchasesError) throw updatePurchasesError;

  const { error: updateUploadError } = await scoped.from('purchase_upload').update({ product_id: newProductId }).eq('id', uploadId);
  if (updateUploadError) throw updateUploadError;

  let rewaived = 0;
  for (const p of purchases) {
    if (!p.person_id) continue;
    rewaived += await applyWaivers(p.person_id, p.id);
  }

  return { purchasesUpdated: purchaseIds.length, rewaived };
}

export async function undoUpload(clubId: string, uploadId: string): Promise<{ deletedPurchases: number }> {
  const scoped = createClubScopedClient(clubId);

  const { data: purchases, error } = await scoped.from('purchase').select('id').eq('upload_id', uploadId);
  if (error) throw error;
  const purchaseIds = (purchases ?? []).map((p) => p.id);

  if (purchaseIds.length > 0) {
    const { error: unwaiveError } = await scoped
      .from('attendance_record')
      .update({ waived_by_purchase_id: null })
      .in('waived_by_purchase_id', purchaseIds);
    if (unwaiveError) throw unwaiveError;

    const { error: deleteError } = await scoped.from('purchase').delete().in('id', purchaseIds);
    if (deleteError) throw deleteError;
  }

  const { error: deleteUploadError } = await scoped.from('purchase_upload').delete().eq('id', uploadId);
  if (deleteUploadError) throw deleteUploadError;

  return { deletedPurchases: purchaseIds.length };
}
```

Note: `changeUploadProduct`/`undoUpload`/`rematchUnmatchedPurchases`'s own `uploadId`/`purchase` selects, now run through `scoped`, already return 0 rows for a cross-club `uploadId` (the scoped client auto-filters). `undoUpload` on a cross-club id therefore now correctly becomes a no-op (`deletedPurchases: 0`) instead of an IDOR — that's a second, implicit fix from this task worth calling out in the task's self-review but not worth its own extra test given it's the same mechanism the explicit `changeUploadProduct` test above already proves.

Update `lib/purchase/actions.ts`:

```ts
export async function rematchUnmatchedPurchases(clubSlug: string) {
  const { clubId } = await requireAdmin(clubSlug);
  return rematchUnmatchedPurchasesImpl(clubId);
}

export async function changeUploadProduct(clubSlug: string, uploadId: string, newProductId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  const parsedUploadId = idSchema.parse(uploadId);
  const parsedProductId = idSchema.parse(newProductId);
  return changeUploadProductImpl(clubId, parsedUploadId, parsedProductId);
}

export async function undoUpload(clubSlug: string, uploadId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  const parsedUploadId = idSchema.parse(uploadId);
  return undoUploadImpl(clubId, parsedUploadId);
}
```

And update `app/api/cron/chase-emails/route.ts`'s call to `reapplyWaiversForEveryoneWithDebt()` — leave it as-is for this task (it will fail to compile until Task 11 rewrites the whole route to loop over clubs; that's expected and owned by Task 11, not this one).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-upload.spec.ts tests/integration/purchase-waivers.spec.ts`
Expected: PASS. `npx tsc --noEmit` will show exactly one remaining error, in `app/api/cron/chase-emails/route.ts` (Task 11's job) — confirm no other file is affected.

- [ ] **Step 5: Commit**

```bash
git add lib/purchase/interface.ts lib/purchase/actions.ts tests/integration/purchase-upload.spec.ts tests/integration/purchase-waivers.spec.ts
git commit -m "feat(purchase): scope rematchUnmatchedPurchases/listRecentUploads/changeUploadProduct/undoUpload/reapplyWaiversForEveryoneWithDebt by club"
```

---

## Task 8: `listProducts` and the XLSX uploader's product check

**Files:**
- Modify: `lib/purchase/queries.ts`
- Modify: `lib/xlsx/uploader.ts`
- Modify: `app/club/[clubSlug]/admin/purchases/page.tsx`
- Test: new `tests/integration/purchase-queries.spec.ts`

**Interfaces:**
- Consumes: `createClubScopedClient` (Task 1).
- Produces: `listProducts(clubId)` (**signature change** — `clubId` added, required).

- [ ] **Step 1: Write the failing test**

There's no existing integration test for `listProducts` — create `tests/integration/purchase-queries.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listProducts } from "@/lib/purchase/queries";

const admin = createAdminClient();

let judoClubId: string;
let taekwondoClubId: string;
test.beforeAll(async () => {
  const { data: judo, error: judoError } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (judoError) throw judoError;
  judoClubId = judo.id;
  const { data: taekwondo, error: tkdError } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  if (tkdError) throw tkdError;
  taekwondoClubId = taekwondo.id;
});

test.describe("listProducts", () => {
  let productIds: string[] = [];

  test.afterEach(async () => {
    if (productIds.length === 0) return;
    const { error } = await admin.from("product").delete().in("id", productIds);
    if (error) throw error;
    productIds = [];
  });

  test("never includes a product belonging to a different club", async () => {
    const judoName = `Judo Products Test ${crypto.randomUUID()}`;
    const tkdName = `Taekwondo Products Test ${crypto.randomUUID()}`;
    const { data: judoProduct, error: judoError } = await admin
      .from("product")
      .insert({ club_id: judoClubId, name: judoName, kind: "other" })
      .select("id")
      .single();
    if (judoError) throw judoError;
    const { data: tkdProduct, error: tkdError } = await admin
      .from("product")
      .insert({ club_id: taekwondoClubId, name: tkdName, kind: "other" })
      .select("id")
      .single();
    if (tkdError) throw tkdError;
    productIds.push(judoProduct!.id, tkdProduct!.id);

    const results = await listProducts(judoClubId);
    expect(results.some((p) => p.id === judoProduct!.id)).toBe(true);
    expect(results.some((p) => p.id === tkdProduct!.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-queries.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```ts
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

export interface ProductListItem {
  id: string;
  name: string;
}

export async function listProducts(clubId: string): Promise<ProductListItem[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped.from("product").select("id, name").order("name");
  if (error) {
    throw new Error(`Failed to list products: ${error.message}`);
  }
  return data ?? [];
}
```

In `lib/xlsx/uploader.ts`, scope the product-existence check (currently a raw `createAdminClient()` lookup with no club filter):

```ts
export async function uploadXlsx(clubSlug: string, formData: FormData): Promise<UploadXlsxResult> {
  const adminUser = await requireAdmin(clubSlug);

  const parsedProductId = productIdSchema.safeParse(formData.get("productId"));
  if (!parsedProductId.success) {
    return { success: false, message: "Select which pass/product this file is for." };
  }

  const scoped = createClubScopedClient(adminUser.clubId);
  const { data: product, error: productError } = await scoped
    .from("product")
    .select("id")
    .eq("id", parsedProductId.data)
    .maybeSingle();
  if (productError) throw productError;
  if (!product) {
    return { success: false, message: "Selected product no longer exists — refresh and try again." };
  }

  // ... file/rows validation unchanged ...

  const { data: upload, error: uploadError } = await scoped
    .from("purchase_upload")
    .insert({
      product_id: product.id,
      filename: file.name,
      row_count: rows.length,
      uploaded_by: adminUser.email,
    })
    .select("id")
    .single();
  if (uploadError) throw uploadError;

  const result = await ingestPurchases(rows.map((row) => ({ ...row, uploadId: upload.id })), adminUser.clubId);

  // ... unchanged message formatting ...
}
```

Replace the `import { createAdminClient } from "@/lib/supabase/admin";` line with `import { createClubScopedClient } from "@/lib/supabase/club-scoped";` and remove the now-unused `const admin = createAdminClient();` line.

Update `app/club/[clubSlug]/admin/purchases/page.tsx`'s call site:

```ts
  const { clubId } = await requireAdmin(clubSlug); // was: await requireAdmin(clubSlug); (discarded)
  // ...
  const [{ data: rawPurchases }, products, recentUploads] = await Promise.all([
    admin
      .from('purchase')
      .select(/* unchanged */)
      .eq('club_id', clubId) // ADD this filter -- see Task 13 for this page's full scoping pass
      .order('purchased_at', { ascending: false })
      .limit(20),
    listProducts(clubId),
    listRecentUploads(clubId, 5),
  ]);
```

(The `.eq('club_id', clubId)` on the raw `purchase` query is listed here only because `listProducts`/`listRecentUploads`'s new required argument would otherwise break this page's build immediately — the rest of this page's scoping (the raw `purchase` select, `XlsxUploader`/`RecentUploads`/`PurchasesTable` props) is Task 13's full pass; don't expand scope here beyond making the page compile and the two calls genuinely club-scoped.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/purchase-queries.spec.ts && npx tsc --noEmit`
Expected: PASS for the new test. `tsc` should show no errors outside the files this task and Task 11 own.

- [ ] **Step 5: Commit**

```bash
git add lib/purchase/queries.ts lib/xlsx/uploader.ts "app/club/[clubSlug]/admin/purchases/page.tsx" tests/integration/purchase-queries.spec.ts
git commit -m "feat(purchase): scope listProducts and the XLSX uploader's product check by club"
```

---

## Task 9: Chase debt-cycles and generator

**Files:**
- Modify: `lib/chase/debt-cycles.ts`
- Modify: `lib/chase/generator.ts`
- Modify: `app/club/[clubSlug]/admin/unpaid/page.tsx`
- Test: new `tests/integration/debt-cycles-club-scoping.spec.ts`, `tests/integration/chase-generator.spec.ts`

**Interfaces:**
- Consumes: `createClubScopedClient` (Task 1); the `active_debt_cycle` view is already in `CLUB_SCOPED_TABLES`.
- Produces: `listActiveDebtCycles(clubId)`, `generateChaseEmails(clubId)` (**signature changes** — both gain a required `clubId`).

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/debt-cycles-club-scoping.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listActiveDebtCycles } from "@/lib/chase/debt-cycles";

const admin = createAdminClient();

let judoClubId: string;
let taekwondoClubId: string;
test.beforeAll(async () => {
  const { data: judo, error: judoError } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (judoError) throw judoError;
  judoClubId = judo.id;
  const { data: taekwondo, error: tkdError } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  if (tkdError) throw tkdError;
  taekwondoClubId = taekwondo.id;
});

test.describe("listActiveDebtCycles is scoped by club", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (personIds.length) {
      await admin.from("person").delete().in("id", personIds);
      personIds = [];
    }
  });

  test("a Taekwondo debtor never appears in a Judo-scoped call", async () => {
    const { data: tkdPerson, error } = await admin
      .from("person")
      .insert({ club_id: taekwondoClubId, full_name: "Taekwondo Debtor", email: `tkd-debt-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(tkdPerson!.id);

    for (const daysAgo of [20, 10]) {
      const { data: session, error: sessionError } = await admin
        .from("session")
        .insert({ club_id: taekwondoClubId, title: "Taekwondo Debt Test Session", starts_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString() })
        .select("id")
        .single();
      if (sessionError) throw sessionError;
      sessionIds.push(session!.id);
      const { error: attendanceError } = await admin
        .from("attendance_record")
        .insert({ club_id: taekwondoClubId, person_id: tkdPerson!.id, session_id: session!.id, source: "manual_tick" });
      if (attendanceError) throw attendanceError;
    }

    const judoResults = await listActiveDebtCycles(judoClubId);
    expect(judoResults.some((c) => c.personId === tkdPerson!.id)).toBe(false);

    const taekwondoResults = await listActiveDebtCycles(taekwondoClubId);
    expect(taekwondoResults.some((c) => c.personId === tkdPerson!.id)).toBe(true);
  });
});
```

In `tests/integration/chase-generator.spec.ts`, update every `generateChaseEmails()` call (6 sites) to `generateChaseEmails(judoClubId)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/debt-cycles-club-scoping.spec.ts tests/integration/chase-generator.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```ts
// lib/chase/debt-cycles.ts
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

export type ActiveDebtCycle = {
  personId: string;
  fullName: string;
  email: string;
  debtCycleStartedAt: string;
  debtCount: number;
};

export async function listActiveDebtCycles(clubId: string): Promise<ActiveDebtCycle[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
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

```ts
// lib/chase/generator.ts
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { listActiveDebtCycles } from "@/lib/chase/debt-cycles";
import { buildChaseEmailContent } from "@/lib/chase/template";

// ... CHASE_THRESHOLD_DAYS / daysBetween unchanged ...

export async function generateChaseEmails(clubId: string): Promise<{ created: number }> {
  const scoped = createClubScopedClient(clubId);
  const cycles = await listActiveDebtCycles(clubId);
  const now = new Date();
  let created = 0;

  for (const cycle of cycles) {
    const { data: existing, error: existingError } = await scoped
      .from("chase_email")
      .select("sequence_number, status, sent_at")
      .eq("person_id", cycle.personId)
      .eq("debt_cycle_started_at", cycle.debtCycleStartedAt)
      .order("sequence_number", { ascending: false })
      .limit(1);

    if (existingError) {
      throw new Error(`Failed to look up existing chase emails for person ${cycle.personId}: ${existingError.message}`);
    }

    const last = existing?.[0];
    let shouldGenerate = false;
    let nextSequence = 1;

    if (!last) {
      shouldGenerate = daysBetween(new Date(cycle.debtCycleStartedAt), now) > CHASE_THRESHOLD_DAYS;
    } else if (last.status === "sent" && last.sent_at) {
      nextSequence = last.sequence_number + 1;
      shouldGenerate = daysBetween(new Date(last.sent_at), now) > CHASE_THRESHOLD_DAYS;
    }

    if (!shouldGenerate) continue;

    const { subject, body } = buildChaseEmailContent({ fullName: cycle.fullName, debtCount: cycle.debtCount });
    const autoApproved = nextSequence > 1 && process.env.CHASE_AUTO_SEND_REPEATS === "true";
    const status = nextSequence === 1 ? "pending_approval" : autoApproved ? "approved" : "pending_approval";

    const { error: insertError } = await scoped.from("chase_email").insert({
      person_id: cycle.personId,
      debt_cycle_started_at: cycle.debtCycleStartedAt,
      sequence_number: nextSequence,
      status,
      subject,
      body,
      approved_by: autoApproved ? "system:CHASE_AUTO_SEND_REPEATS" : null,
      approved_at: autoApproved ? new Date().toISOString() : null,
    });

    if (insertError) {
      if (insertError.code === "23503") {
        console.warn(`Skipped chase_email for person ${cycle.personId}: their debt cycle disappeared (FK violation) between listing and insert.`);
        continue;
      }
      throw new Error(`Failed to create chase_email for person ${cycle.personId}: ${insertError.message}`);
    }

    created++;
  }

  return { created };
}
```

Update `app/club/[clubSlug]/admin/unpaid/page.tsx`:

```ts
  const { clubId } = await requireAdmin(clubSlug); // was: await requireAdmin(clubSlug); (discarded)
  // ...
  const cycles = (await listActiveDebtCycles(clubId)).sort((a, b) => { /* unchanged */ });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/debt-cycles-club-scoping.spec.ts tests/integration/chase-generator.spec.ts && npx tsc --noEmit`
Expected: PASS. Remaining `tsc` errors should be confined to `app/api/cron/chase-emails/route.ts` (Task 11) and `lib/chase/generator.ts`'s own now-dangling `getDefaultClubId` import, if the edit above didn't already drop it — double check it's removed.

- [ ] **Step 5: Commit**

```bash
git add lib/chase/debt-cycles.ts lib/chase/generator.ts "app/club/[clubSlug]/admin/unpaid/page.tsx" tests/integration/debt-cycles-club-scoping.spec.ts tests/integration/chase-generator.spec.ts
git commit -m "feat(chase): scope listActiveDebtCycles/generateChaseEmails by club"
```

---

## Task 10: Chase send, approval-writer, and queries

**Files:**
- Modify: `lib/chase/send.ts`
- Modify: `lib/chase/approval-writer.ts`
- Modify: `lib/chase/queries.ts`
- Modify: `lib/chase/actions.ts`
- Modify: `app/club/[clubSlug]/sessions/page.tsx` (finish Task 2's deferred half)
- Test: `tests/integration/chase-send.spec.ts`, `tests/integration/chase-approval.spec.ts`, `tests/integration/chase-queries.spec.ts`

**Interfaces:**
- Consumes: `createClubScopedClient` (Task 1).
- Produces: `sendChaseEmail(chaseEmailId, clubId, adapter?)`, `processAutoSends(clubId, adapter?)`, `approveChaseEmail(chaseEmailId, clubId, actorEmail)`, `rejectChaseEmail(chaseEmailId, clubId, note, actorEmail)`, `countFailedChaseEmails(clubId)` (**all signature changes** — `clubId` added; placed right after the id for the single-row functions, matching the existing `(id, ...rest)` ordering those already use, and first for the no-id functions).

- [ ] **Step 1: Write the failing tests**

In `tests/integration/chase-send.spec.ts`: update every `sendChaseEmail(chaseEmailId, ...)` call to `sendChaseEmail(chaseEmailId, judoClubId, ...)` (6 sites) and every `processAutoSends(...)` call to `processAutoSends(judoClubId, ...)` (6 sites, including the zero-arg ones which become `processAutoSends(judoClubId)`).

In `tests/integration/chase-approval.spec.ts`: update every `approveChaseEmail(chaseEmailId, TEST_ADMIN_EMAIL)` to `approveChaseEmail(chaseEmailId, judoClubId, TEST_ADMIN_EMAIL)` (3 sites) and every `rejectChaseEmail(chaseEmailId, note, TEST_ADMIN_EMAIL)` to `rejectChaseEmail(chaseEmailId, judoClubId, note, TEST_ADMIN_EMAIL)` (5 sites). Both files need a `judoClubId` resolved via `test.beforeAll` the same way `chase-generator.spec.ts` already does — add that block if it's not already present.

In `tests/integration/chase-queries.spec.ts`: update the one `countFailedChaseEmails()` call to `countFailedChaseEmails(judoClubId)` (2 sites — `before` and `after`), adding the same `beforeAll` block.

Add one new cross-tenant test to `tests/integration/chase-send.spec.ts`:

```ts
  test("sendChaseEmail refuses a chaseEmailId that belongs to a different club", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const { data: tkdPerson, error: personError } = await admin
      .from("person")
      .insert({ club_id: taekwondo!.id, full_name: "Taekwondo Chase Person", email: `tkd-chase-send-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    if (personError) throw personError;

    const { data: tkdChase, error: chaseError } = await admin
      .from("chase_email")
      .insert({
        club_id: taekwondo!.id,
        person_id: tkdPerson!.id,
        debt_cycle_started_at: new Date().toISOString(),
        sequence_number: 1,
        status: "approved",
        subject: "test",
        body: "test",
      })
      .select("id")
      .single();
    if (chaseError) throw chaseError;

    await expect(sendChaseEmail(tkdChase!.id, judoClubId, fakeAdapter())).rejects.toThrow();

    await admin.from("chase_email").delete().eq("id", tkdChase!.id);
    await admin.from("person").delete().eq("id", tkdPerson!.id);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/chase-send.spec.ts tests/integration/chase-approval.spec.ts tests/integration/chase-queries.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```ts
// lib/chase/send.ts
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import type { EmailChannelAdapter } from "@/lib/email/types";
import { resendEmailAdapter } from "@/lib/email/resend-adapter";

export async function sendChaseEmail(
  chaseEmailId: string,
  clubId: string,
  adapter: EmailChannelAdapter = resendEmailAdapter
): Promise<{ sent: boolean; reason?: string }> {
  const scoped = createClubScopedClient(clubId);

  const { data: row, error: fetchError } = await scoped
    .from("chase_email")
    .select("id, person_id, status, subject, body")
    .eq("id", chaseEmailId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to fetch chase_email ${chaseEmailId}: ${fetchError.message}`);
  if (!row) throw new Error(`chase_email ${chaseEmailId} does not belong to this club.`);
  if (row.status !== "approved") {
    throw new Error(`chase_email ${chaseEmailId} is not approved (status: ${row.status}) -- refusing to send`);
  }

  const { data: person, error: personError } = await scoped
    .from("person")
    .select("is_exempt, email")
    .eq("id", row.person_id)
    .single();
  if (personError) throw new Error(`Failed to fetch person ${row.person_id}: ${personError.message}`);

  if (person.is_exempt) {
    const { error: cancelError } = await scoped
      .from("chase_email")
      .update({ status: "cancelled", note: "Auto-cancelled: person was exempted before send." })
      .eq("id", chaseEmailId)
      .eq("status", "approved");
    if (cancelError) throw new Error(`Failed to cancel chase_email ${chaseEmailId}: ${cancelError.message}`);
    return { sent: false, reason: "exempt" };
  }

  const debt = await getOutstandingDebt(row.person_id);

  if (debt <= 0) {
    const { error: cancelError } = await scoped
      .from("chase_email")
      .update({ status: "cancelled", note: "Auto-cancelled: debt was already cleared before send." })
      .eq("id", chaseEmailId)
      .eq("status", "approved");
    if (cancelError) throw new Error(`Failed to cancel chase_email ${chaseEmailId}: ${cancelError.message}`);
    return { sent: false, reason: "debt_cleared" };
  }

  const { data: claimedRows, error: claimError } = await scoped
    .from("chase_email")
    .update({ status: "sending" })
    .eq("id", chaseEmailId)
    .eq("status", "approved")
    .select("id");
  if (claimError) throw new Error(`Failed to claim chase_email ${chaseEmailId} for sending: ${claimError.message}`);
  if ((claimedRows?.length ?? 0) === 0) {
    return { sent: false, reason: "stale" };
  }

  try {
    const { providerMessageId } = await adapter.send({
      to: person.email,
      subject: row.subject,
      body: row.body,
      idempotencyKey: chaseEmailId,
    });

    const { error: sendError } = await scoped
      .from("chase_email")
      .update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: providerMessageId })
      .eq("id", chaseEmailId);
    if (sendError) throw new Error(`Failed to record sent chase_email ${chaseEmailId}: ${sendError.message}`);
    return { sent: true };
  } catch (sendAttemptError) {
    const message = sendAttemptError instanceof Error ? sendAttemptError.message : String(sendAttemptError);
    const { error: failError } = await scoped
      .from("chase_email")
      .update({ status: "failed", note: message.slice(0, 1000) })
      .eq("id", chaseEmailId);
    if (failError) throw new Error(`Failed to record failed chase_email ${chaseEmailId}: ${failError.message}`);
    return { sent: false, reason: "send_failed" };
  }
}

export async function processAutoSends(
  clubId: string,
  adapter: EmailChannelAdapter = resendEmailAdapter
): Promise<{ sent: number; cancelled: number; failed: number }> {
  if (process.env.CHASE_AUTO_SEND_REPEATS !== "true") {
    return { sent: 0, cancelled: 0, failed: 0 };
  }

  const scoped = createClubScopedClient(clubId);
  const { data: rows, error } = await scoped
    .from("chase_email")
    .select("id")
    .eq("status", "approved")
    .gt("sequence_number", 1);

  if (error) throw new Error(`Failed to list auto-sendable chase emails: ${error.message}`);

  const rowsToSend = rows ?? [];
  let sent = 0;
  let cancelled = 0;
  let failed = 0;

  for (let i = 0; i < rowsToSend.length; i++) {
    const result = await sendChaseEmail(rowsToSend[i].id, clubId, adapter);
    if (result.sent) sent++;
    else if (result.reason === "send_failed") failed++;
    else cancelled++;

    if (i < rowsToSend.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return { sent, cancelled, failed };
}
```

```ts
// lib/chase/approval-writer.ts
import { z } from "zod";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

const rejectChaseEmailSchema = z.object({
  chaseEmailId: z.string().uuid(),
  note: z.string().trim().min(1).max(1000),
  actorEmail: z.string(),
});

export async function approveChaseEmail(
  chaseEmailId: string,
  clubId: string,
  actorEmail: string
): Promise<{ approved: boolean }> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("chase_email")
    .update({ status: "approved", approved_by: actorEmail, approved_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .in("status", ["pending_approval", "failed"])
    .select("id");

  if (error) throw new Error(`Failed to approve chase_email ${chaseEmailId}: ${error.message}`);
  return { approved: (data?.length ?? 0) > 0 };
}

export async function rejectChaseEmail(
  chaseEmailId: string,
  clubId: string,
  note: string,
  actorEmail: string
): Promise<{ rejected: boolean }> {
  const parsed = rejectChaseEmailSchema.parse({ chaseEmailId, note, actorEmail });
  const scoped = createClubScopedClient(clubId);
  const attributedNote = `${parsed.actorEmail} @ ${new Date().toISOString()}: ${parsed.note}`;
  const { data, error } = await scoped
    .from("chase_email")
    .update({ status: "cancelled", note: attributedNote })
    .eq("id", parsed.chaseEmailId)
    .in("status", ["pending_approval", "approved", "failed"])
    .select("id");

  if (error) throw new Error(`Failed to reject chase_email ${chaseEmailId}: ${error.message}`);
  return { rejected: (data?.length ?? 0) > 0 };
}
```

```ts
// lib/chase/queries.ts
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

export async function countFailedChaseEmails(clubId: string): Promise<number> {
  const scoped = createClubScopedClient(clubId);
  const { count, error } = await scoped
    .from("chase_email")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed");

  if (error) throw new Error(`Failed to count failed chase emails: ${error.message}`);
  return count ?? 0;
}
```

```ts
// lib/chase/actions.ts
"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { approveChaseEmail, rejectChaseEmail } from "@/lib/chase/approval-writer";
import { sendChaseEmail } from "@/lib/chase/send";

export async function approveChase(clubSlug: string, chaseEmailId: string): Promise<{ approved: boolean }> {
  const admin = await requireAdmin(clubSlug);
  return approveChaseEmail(chaseEmailId, admin.clubId, admin.email);
}

export async function sendChase(clubSlug: string, chaseEmailId: string): Promise<{ sent: boolean; reason?: string }> {
  const admin = await requireAdmin(clubSlug);
  return sendChaseEmail(chaseEmailId, admin.clubId);
}

export async function rejectChase(clubSlug: string, chaseEmailId: string, note: string): Promise<{ rejected: boolean }> {
  const admin = await requireAdmin(clubSlug);
  return rejectChaseEmail(chaseEmailId, admin.clubId, note, admin.email);
}
```

Finish Task 2's deferred half in `app/club/[clubSlug]/sessions/page.tsx`:

```ts
  const { clubId } = await requireAdmin(clubSlug);
  // ...
  const [sessions, failedChaseCount] = await Promise.all([
    listRecentSessions(clubId),
    countFailedChaseEmails(clubId),
  ]);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/chase-send.spec.ts tests/integration/chase-approval.spec.ts tests/integration/chase-queries.spec.ts && npx tsc --noEmit`
Expected: PASS. Remaining `tsc` errors confined to `app/api/cron/chase-emails/route.ts` (Task 11).

- [ ] **Step 5: Commit**

```bash
git add lib/chase/send.ts lib/chase/approval-writer.ts lib/chase/queries.ts lib/chase/actions.ts "app/club/[clubSlug]/sessions/page.tsx" tests/integration/chase-send.spec.ts tests/integration/chase-approval.spec.ts tests/integration/chase-queries.spec.ts
git commit -m "feat(chase): scope sendChaseEmail/processAutoSends/approveChaseEmail/rejectChaseEmail/countFailedChaseEmails by club"
```

---

## Task 11: The weekly cron route loops over every club

**Files:**
- Modify: `app/api/cron/chase-emails/route.ts`

**Interfaces:**
- Consumes: `reapplyWaiversForEveryoneWithDebt(clubId)` (Task 7), `generateChaseEmails(clubId)` (Task 9), `processAutoSends(clubId, adapter?)` (Task 10).
- Produces: the route's JSON response shape changes from `{ reapplied, generated, sent }` to `{ results: { clubSlug: string; reapplied; generated; sent }[] }` — there's no existing test asserting the old flat shape (confirm with a search for `tests/.*cron`; if none exists, this is a safe shape change with no test migration needed).

- [ ] **Step 1: Write the failing test**

There is no existing test file for this route. Create `tests/integration/cron-chase-emails.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET as cronGet } from "@/app/api/cron/chase-emails/route";

const admin = createAdminClient();

test.describe("GET /api/cron/chase-emails", () => {
  const originalSecret = process.env.CRON_SECRET;

  test.afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  test("rejects a missing/wrong bearer token with 401", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const request = new Request("http://localhost/api/cron/chase-emails", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    const response = await cronGet(request);
    expect(response.status).toBe(401);
  });

  test("processes every club, not just one", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const request = new Request("http://localhost/api/cron/chase-emails", {
      headers: { authorization: "Bearer correct-secret" },
    });
    const response = await cronGet(request);
    expect(response.status).toBe(200);
    const body = await response.json();

    const { data: clubs, error } = await admin.from("club").select("slug");
    if (error) throw error;
    const processedSlugs = body.results.map((r: { clubSlug: string }) => r.clubSlug);
    for (const club of clubs ?? []) {
      expect(processedSlugs).toContain(club.slug);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/cron-chase-emails.spec.ts`
Expected: FAIL — the route still calls the three functions with no `clubId` argument, so it fails to compile/typecheck, and the response shape doesn't have `.results`.

- [ ] **Step 3: Implement**

```ts
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateChaseEmails } from "@/lib/chase/generator";
import { processAutoSends } from "@/lib/chase/send";
import { reapplyWaiversForEveryoneWithDebt } from "@/lib/purchase/interface";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: clubs, error: clubsError } = await admin.from("club").select("id, slug");
  if (clubsError) {
    return NextResponse.json({ error: `Failed to list clubs: ${clubsError.message}` }, { status: 500 });
  }

  const results: {
    clubSlug: string;
    reapplied?: Awaited<ReturnType<typeof reapplyWaiversForEveryoneWithDebt>>;
    generated?: Awaited<ReturnType<typeof generateChaseEmails>>;
    sent?: Awaited<ReturnType<typeof processAutoSends>>;
    error?: string;
  }[] = [];

  for (const club of clubs ?? []) {
    try {
      const reapplied = await reapplyWaiversForEveryoneWithDebt(club.id);
      const generated = await generateChaseEmails(club.id);
      const sent = await processAutoSends(club.id);
      results.push({ clubSlug: club.slug, reapplied, generated, sent });
    } catch (error) {
      // One club's failure (e.g. a bad row, a transient Resend outage)
      // must never block the rest -- same reasoning as ingestPurchases's
      // per-row try/catch.
      console.error(`Chase-email cron failed for club "${club.slug}":`, error);
      results.push({ clubSlug: club.slug, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return NextResponse.json({ results });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/cron-chase-emails.spec.ts && npx tsc --noEmit`
Expected: PASS. `tsc` should now be completely clean — this was the last file blocking it.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/chase-emails/route.ts tests/integration/cron-chase-emails.spec.ts
git commit -m "feat(chase): loop the weekly cron over every club instead of a single hardcoded one"
```

---

## Task 12: `lib/person/exempt-writer.ts`

**Files:**
- Modify: `lib/person/exempt-writer.ts`
- Modify: `lib/person/actions.ts`
- Test: `tests/integration/person-exempt.spec.ts`

**Interfaces:**
- Consumes: `createClubScopedClient` (Task 1).
- Produces: `applyPersonExempt(input, clubId, actorEmail)` (**signature change** — `clubId` inserted as the second parameter).

- [ ] **Step 1: Write the failing test**

Read `tests/integration/person-exempt.spec.ts` first to confirm its exact `applyPersonExempt(input, actorEmail)` call pattern and how it resolves a club id (if at all — it may currently insert test people with a hardcoded/default club). Update every call site to `applyPersonExempt(input, judoClubId, actorEmail)`, adding a `test.beforeAll` that resolves `judoClubId` if the file doesn't already have one. Add a new test:

```ts
  test("refuses to update a person who belongs to a different club", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const { data: tkdPerson, error } = await admin
      .from("person")
      .insert({ club_id: taekwondo!.id, full_name: "Taekwondo Exempt Test", email: `tkd-exempt-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    if (error) throw error;

    await expect(
      applyPersonExempt({ personId: tkdPerson!.id, exempt: true }, judoClubId, TEST_ADMIN_EMAIL)
    ).rejects.toThrow();

    await admin.from("person").delete().eq("id", tkdPerson!.id);
  });
```

(Use whatever the file's existing admin-email constant is named — confirm by reading the file; `TEST_ADMIN_EMAIL` is this plan's placeholder for that existing constant's name, not a new one to add.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/person-exempt.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```ts
import { z } from "zod";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

const setPersonExemptSchema = z.object({
  personId: z.string().uuid(),
  exempt: z.boolean(),
  reason: z.string().max(500).optional(),
});

export type SetPersonExemptInput = z.infer<typeof setPersonExemptSchema>;

export async function applyPersonExempt(
  input: SetPersonExemptInput,
  clubId: string,
  actorEmail: string
): Promise<void> {
  const parsed = setPersonExemptSchema.parse(input);
  const scoped = createClubScopedClient(clubId);

  const { data, error } = await scoped
    .from("person")
    .update({
      is_exempt: parsed.exempt,
      exempt_set_by: parsed.exempt ? actorEmail : null,
      exempt_set_at: parsed.exempt ? new Date().toISOString() : null,
      exempt_reason: parsed.exempt ? (parsed.reason ?? null) : null,
    })
    .eq("id", parsed.personId)
    .select("id");

  if (error) {
    throw new Error(`Failed to update exemption for person ${parsed.personId}: ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error(`Person ${parsed.personId} does not belong to this club.`);
  }
}
```

Update `lib/person/actions.ts`:

```ts
export async function setPersonExempt(clubSlug: string, input: SetPersonExemptInput): Promise<void> {
  const admin_user = await requireAdmin(clubSlug);
  await applyPersonExempt(input, admin_user.clubId, admin_user.email);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/person-exempt.spec.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/person/exempt-writer.ts lib/person/actions.ts tests/integration/person-exempt.spec.ts
git commit -m "feat(person): scope applyPersonExempt by club"
```

---

## Task 13: Admin dashboard pages' own raw queries

**Files:**
- Modify: `app/club/[clubSlug]/admin/purchases/page.tsx`
- Modify: `app/club/[clubSlug]/admin/chase-inbox/page.tsx`

**Interfaces:**
- Consumes: `createClubScopedClient` (Task 1). No exported function signatures change in this task — it's purely these two pages' own inline Supabase queries.

(`app/club/[clubSlug]/admin/unpaid/page.tsx` and `app/club/[clubSlug]/sessions/page.tsx` are already fully scoped as of Tasks 9-10 — no further change needed to either.)

- [ ] **Step 1: Write the failing test**

There's no existing integration test for either page's raw query (these are server components, not independently testable functions) — this task is instead verified via a new Playwright e2e-level check. Add to `tests/e2e/admin-auth-gate.spec.ts` (read the file first to match its existing login-and-navigate helper pattern) a new test:

```ts
test("the purchases page for one club never lists another club's purchase rows", async ({ page }) => {
  // Seed: one Judo purchase, one Taekwondo purchase, both with an
  // unmistakably distinct raw_person_name, via the admin client fixture
  // this file's existing tests already use for seeding.
  // ... use this file's existing admin-login helper to sign in as a Judo
  // admin, navigate to /club/judo/admin/purchases, and assert the
  // Taekwondo row's raw_person_name text never appears on the page while
  // the Judo row's does. Follow this file's existing page-object/selector
  // conventions exactly -- read the file first, since this plan can't
  // predict its exact helper names without reading it live.
});
```

Since this is an e2e test gated behind real cookie-based auth (unlike the `tests/integration/*` suite, which uses the service-role client directly), writing its exact body requires reading `tests/e2e/admin-auth-gate.spec.ts`'s current login helper during implementation — do that as the first action of this step, then fill in the real assertions using its existing patterns (e.g. its `loginAs(page, email, password)` helper, if one exists) rather than inventing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts` (note: this is the **non**-integration config — `playwright.config.ts`, since e2e tests need the dev server, per that config's `webServer` block)
Expected: FAIL — the purchases page currently has no `.eq('club_id', ...)` filter on its raw `purchase` select (Task 8 only added one earlier in this plan — confirm it's still there and extend it if needed) and the chase-inbox page has none at all yet.

- [ ] **Step 3: Implement**

`app/club/[clubSlug]/admin/purchases/page.tsx`:

```tsx
import Link from 'next/link';
import { requireAdmin, UnauthorizedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';
import { createClubScopedClient } from '@/lib/supabase/club-scoped';
import { XlsxUploader } from '@/components/purchase/xlsx-uploader';
import { PurchasesTable, type PurchaseRow } from '@/components/purchase/purchases-table';
import { RecentUploads } from '@/components/purchase/recent-uploads';
import { listProducts } from '@/lib/purchase/queries';
import { listRecentUploads } from '@/lib/purchase/interface';
import { clubPath } from '@/lib/club-path';

export const dynamic = 'force-dynamic';

export default async function AdminPurchasesPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  let clubId: string;
  try {
    ({ clubId } = await requireAdmin(clubSlug));
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect('/login');
    throw error;
  }

  const scoped = createClubScopedClient(clubId);
  const [{ data: rawPurchases }, products, recentUploads] = await Promise.all([
    scoped
      .from('purchase')
      .select(
        'id, raw_person_name, raw_cid, raw_email, source, purchased_at, match_status, product:product_id(name), person:person_id(full_name)'
      )
      .order('purchased_at', { ascending: false })
      .limit(20),
    listProducts(clubId),
    listRecentUploads(clubId, 5),
  ]);

  // ... mapping/rendering unchanged ...
}
```

`app/club/[clubSlug]/admin/chase-inbox/page.tsx`:

```tsx
import Link from "next/link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { ApprovalActions } from "@/components/chase/approval-actions";
import { clubPath } from "@/lib/club-path";

export const dynamic = "force-dynamic";

export default async function ChaseInboxPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  let clubId: string;
  try {
    ({ clubId } = await requireAdmin(clubSlug));
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const scoped = createClubScopedClient(clubId);
  const { data: chaseEmails } = await scoped
    .from("chase_email")
    .select("id, person_id, sequence_number, status, subject, body, note, created_at")
    .in("status", ["pending_approval", "approved", "failed"])
    .order("created_at", { ascending: true });

  const personIds = [...new Set((chaseEmails ?? []).map((c) => c.person_id))];
  const { data: people } =
    personIds.length > 0
      ? await scoped.from("person").select("id, full_name, email").in("id", personIds)
      : { data: [] };
  const peopleById = new Map((people ?? []).map((p) => [p.id, p]));

  // ... rendering unchanged ...
}
```

(The `scoped.from("person").select(...).in("id", personIds)` call still auto-applies `.eq("club_id", clubId)` underneath the `.in(...)` — `createClubScopedClient`'s `select()` wrapper chains both — so a `personIds` list that somehow contained a cross-club id (it can't today, since `chaseEmails` itself is already club-filtered) would still only return the in-club subset. This is defense-in-depth, not currently reachable, so it needs no dedicated test.)

- [ ] **Step 4: Run tests**

Run: `npx playwright test tests/e2e/admin-auth-gate.spec.ts`
Expected: PASS. Also re-run the full integration suite once more here as a sanity check: `npx playwright test --config=playwright.integration.config.ts`.

- [ ] **Step 5: Commit**

```bash
git add "app/club/[clubSlug]/admin/purchases/page.tsx" "app/club/[clubSlug]/admin/chase-inbox/page.tsx" tests/e2e/admin-auth-gate.spec.ts
git commit -m "feat(admin): scope the purchases and chase-inbox pages' own raw queries by club"
```

---

## Task 14: Delete the Plan 1 hotfix

**Files:**
- Delete: `lib/supabase/default-club.ts`
- Modify: any file a final grep still finds importing it (expected: none, after Tasks 1-13)

**Interfaces:**
- Consumes: nothing — this task only removes code once nothing depends on it.
- Produces: nothing new.

- [ ] **Step 1: Verify nothing still imports it**

Run: `grep -rn "getDefaultClubId\|from \"@/lib/supabase/default-club\"\|from '@/lib/supabase/default-club'" --include="*.ts" --include="*.tsx" lib app`
Expected: zero matches outside `lib/supabase/default-club.ts` itself. If anything else matches, that's a function this plan missed — go back and thread `clubId` through it the same way as every other task before continuing (do not delete the file until this grep is clean; deleting it with a live caller still pointing at it would be exactly the kind of "migration outruns code" incident this whole multi-tenancy effort has repeatedly hit).

- [ ] **Step 2: Delete the file**

```bash
git rm lib/supabase/default-club.ts
```

- [ ] **Step 3: Run the full suite**

Run: `npx tsc --noEmit && npx playwright test --config=playwright.integration.config.ts && npx playwright test tests/unit && npx playwright test tests/e2e`
Expected: everything PASS — `tsc` fails immediately and loudly if any file still imported the deleted module, which is the real safety net here (stronger than the grep in Step 1, which could miss a dynamic import — there are none in this codebase, but this is the actual proof).

- [ ] **Step 4: Also confirm the slug-hardcode grep from the design doc's Group 5**

Run: `grep -rn "slug = 'judo'\|slug === \"judo\"\|eq(\"slug\", \"judo\")\|eq('slug', 'judo')" --include="*.ts" --include="*.tsx" lib app`
Expected: the only matches left should be inside `lib/auth/require-admin.ts`-style generic `.eq("slug", clubSlug)` lookups (parameterized, not hardcoded to the literal `"judo"`) and test fixtures that explicitly want Judo's id for seeding (e.g. `.eq("slug", "judo").single()` in `test.beforeAll` blocks across `tests/integration/*`, which are intentionally Judo-anchored test setup, not production code). Anything else is a leftover this plan's earlier tasks missed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove the Plan 1 getDefaultClubId hotfix now every caller threads a real clubId"
```

---

## Final Verification

Before closing out this plan:
- `npx tsc --noEmit` is clean.
- `npx playwright test --config=playwright.integration.config.ts` is fully green (was 118/118 before this plan started; expect it to grow by roughly 10-12 new cross-tenant tests across Tasks 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12).
- `npx playwright test tests/unit` and `npx playwright test tests/e2e` are both green.
- `grep -rn "getDefaultClubId"` across the whole repo returns nothing.
- Per the design doc's own closing line: **only after this plan's cross-tenant tests pass** should `scripts/create-admin.ts` be run to provision the first real Taekwondo admin — that step is explicitly out of this plan's scope (it's an operational action, not a code change) and belongs to whoever picks up the club onboarding work next.
