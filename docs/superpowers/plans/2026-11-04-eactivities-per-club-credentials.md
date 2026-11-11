# Per-Club eActivities Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global `EACTIVITIES_API_KEY`/`EACTIVITIES_CSP_CODE` env vars and the `EACTIVITIES_CLUB_SLUG` gate with a per-club credential lookup backed by the existing `club_credential` table, so any Imperial club — not just Judo — can use eActivities-based session creation/sync.

**Architecture:** Split credential *resolution* (a new `lib/eactivities/credentials.ts`, doing one `club_credential` lookup) from credential *use* (`EactivitiesProvider`, which becomes a pure API client taking credentials as a constructor argument instead of reading `process.env`). Every call site that currently constructs or implicitly uses a singleton `EactivitiesProvider` resolves that club's credentials first, then constructs a scoped instance. The `EACTIVITIES_CLUB_SLUG` gate disappears — a club with no credential row gets the exact same "use CSV import instead" message it gets today, now driven by a real per-club fact instead of a hardcoded slug.

**Tech Stack:** TypeScript, Supabase (service-role admin client), Zod (unchanged in this plan), Playwright (`tests/integration`).

**Spec:** `docs/superpowers/specs/2026-11-04-eactivities-per-club-credentials-design.md`

## Global Constraints

- Credentials are stored as plaintext JSON in `club_credential.credentials` — no new encryption-at-rest layer (matches every other secret in this codebase; the table already forces RLS to service-role-only access).
- Provisioning is a one-off script (`scripts/set-eactivities-credentials.ts`), matching the existing `scripts/create-admin.ts` convention — no admin UI.
- Pluto is out of scope — this plan only writes/reads `club_credential` rows where `provider = 'eactivities'`.
- The exact user-facing message for a club with no eActivities credentials must stay `"eActivities isn't available for this club yet — use CSV import instead."` — identical to what the current `EACTIVITIES_CLUB_SLUG` gate shows today, so no copy change is visible to an admin.
- `getEactivitiesCredentials` must throw (never return a partial/undefined-filled object) if the stored `credentials` JSON is missing either `apiKey` or `cspCode`.

## Review Focus

- A club with a `club_credential` row that has one field present and the other missing (a hand-typed-wrong provisioning run) must fail loudly at lookup time, not produce a request with `undefined` baked into the Basic-auth header or the URL path — Task 1 owns this with an explicit field-presence check, not just a type cast.
- Judo's existing eActivities flow must keep working identically once its credentials move from env vars into `club_credential` — Task 5's migration step and its own verification own this; nothing about Judo's request shape, auth header, or CSP path may change.
- Re-running the provisioning script for a club that already has a row (e.g. to rotate a leaked key) must update the existing row, not fail on a duplicate primary key or create a second row — Task 5 owns this via `onConflict: 'club_id,provider'`.
- `syncSessionAttendance`'s existing test-fake injection path (`options.provider`) must keep working exactly as before — the new credential-resolution call must only run on the real (non-test) path, never interfere with or require `club_credential` data for tests that already inject a fake provider — Task 4 owns this.
- The provisioning script must never echo the API key back in its own output after storing it — Task 5 owns this explicitly, since `create-admin.ts`'s one-time-password-print precedent could tempt copying that pattern here where it doesn't apply (the caller already has the key; there's nothing to reveal).

---

### Task 1: `getEactivitiesCredentials` and the updated `EactivitiesNotConfiguredError`

**Files:**
- Create: `lib/eactivities/credentials.ts`
- Modify: `lib/eactivities/types.ts` (the `EactivitiesNotConfiguredError` class)
- Test: `tests/integration/eactivities-credentials.spec.ts`

**Interfaces:**
- Consumes: `createAdminClient()` from `@/lib/supabase/admin` (existing).
- Produces: `getEactivitiesCredentials(clubId: string): Promise<{ apiKey: string; cspCode: string }>`, exported from `lib/eactivities/credentials.ts`. `EactivitiesNotConfiguredError` now takes a plain `message: string` instead of a `missingVar: string` (its only current call site, in `lib/eactivities/client.ts`, is updated in this same task so the whole codebase stays consistent — Task 2 will later update it again when `client.ts` itself stops needing this error at all, since credential presence is now checked upstream in `credentials.ts`).

- [ ] **Step 1: Write the failing test**

Create `tests/integration/eactivities-credentials.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEactivitiesCredentials } from "@/lib/eactivities/credentials";
import { EactivitiesNotConfiguredError } from "@/lib/eactivities/types";

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

test.describe("getEactivitiesCredentials", () => {
  let insertedClubIds: string[] = [];

  test.afterEach(async () => {
    if (insertedClubIds.length === 0) return;
    const { error } = await admin.from("club_credential").delete().in("club_id", insertedClubIds).eq("provider", "eactivities");
    if (error) throw error;
    insertedClubIds = [];
  });

  test("returns the stored apiKey/cspCode for a club with a credential row", async () => {
    const { error } = await admin.from("club_credential").insert({
      club_id: taekwondoClubId,
      provider: "eactivities",
      credentials: { apiKey: "test-api-key-123", cspCode: "test-csp-456" },
    });
    if (error) throw error;
    insertedClubIds.push(taekwondoClubId);

    const result = await getEactivitiesCredentials(taekwondoClubId);
    expect(result).toEqual({ apiKey: "test-api-key-123", cspCode: "test-csp-456" });
  });

  test("throws EactivitiesNotConfiguredError when no row exists for the club", async () => {
    await expect(getEactivitiesCredentials(judoClubId)).rejects.toThrow(EactivitiesNotConfiguredError);
  });

  test("throws when the stored credentials are missing cspCode", async () => {
    const { error } = await admin.from("club_credential").insert({
      club_id: taekwondoClubId,
      provider: "eactivities",
      credentials: { apiKey: "test-api-key-only" },
    });
    if (error) throw error;
    insertedClubIds.push(taekwondoClubId);

    await expect(getEactivitiesCredentials(taekwondoClubId)).rejects.toThrow(EactivitiesNotConfiguredError);
  });

  test("throws when the stored credentials are missing apiKey", async () => {
    const { error } = await admin.from("club_credential").insert({
      club_id: taekwondoClubId,
      provider: "eactivities",
      credentials: { cspCode: "test-csp-only" },
    });
    if (error) throw error;
    insertedClubIds.push(taekwondoClubId);

    await expect(getEactivitiesCredentials(taekwondoClubId)).rejects.toThrow(EactivitiesNotConfiguredError);
  });
});
```

(This file assumes `judo` has no `club_credential` row yet at test time — true as of this plan's starting point. If Task 5's Judo migration has already run by the time this test executes, the "throws when no row exists" test would need a different club with no row; re-check this assumption before running and swap to seeding a disposable scenario if Judo already has a row by then.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/eactivities-credentials.spec.ts`
Expected: FAIL — `lib/eactivities/credentials.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

In `lib/eactivities/types.ts`, change the `EactivitiesNotConfiguredError` class:

```ts
export class EactivitiesNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EactivitiesNotConfiguredError";
  }
}
```

In `lib/eactivities/client.ts`, update the two call sites that construct this error with the old single-arg env-var-name convention, since the constructor's contract changed:

```ts
// in eactivitiesFetch:
const apiKey = process.env.EACTIVITIES_API_KEY;
if (!apiKey) throw new EactivitiesNotConfiguredError("EACTIVITIES_API_KEY is not set.");

// in cspPath:
const centre = process.env.EACTIVITIES_CSP_CODE;
if (!centre) throw new EactivitiesNotConfiguredError("EACTIVITIES_CSP_CODE is not set.");
```

(Task 2 removes these two env-var-reading call sites entirely — this is a minimal compile-preserving edit for this task only, not the final state of `client.ts`.)

Create `lib/eactivities/credentials.ts`:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { EactivitiesNotConfiguredError } from "./types";

export interface EactivitiesCredentials {
  apiKey: string;
  cspCode: string;
}

export async function getEactivitiesCredentials(clubId: string): Promise<EactivitiesCredentials> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("club_credential")
    .select("credentials")
    .eq("club_id", clubId)
    .eq("provider", "eactivities")
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    throw new EactivitiesNotConfiguredError(
      `No eActivities credentials configured for club ${clubId}. Run scripts/set-eactivities-credentials.ts for this club, or use CSV import instead.`
    );
  }

  const credentials = data.credentials as Partial<EactivitiesCredentials> | null;
  if (!credentials?.apiKey || !credentials?.cspCode) {
    throw new EactivitiesNotConfiguredError(
      `club_credential row for club ${clubId} (provider "eactivities") is missing apiKey or cspCode -- re-run scripts/set-eactivities-credentials.ts to fix it.`
    );
  }

  return { apiKey: credentials.apiKey, cspCode: credentials.cspCode };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/eactivities-credentials.spec.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add lib/eactivities/credentials.ts lib/eactivities/types.ts lib/eactivities/client.ts tests/integration/eactivities-credentials.spec.ts
git commit -m "feat(eactivities): add getEactivitiesCredentials, generalize EactivitiesNotConfiguredError"
```

---

### Task 2: `client.ts` and `provider.ts` take credentials as parameters

**Files:**
- Modify: `lib/eactivities/client.ts`
- Modify: `lib/eactivities/provider.ts`

**Interfaces:**
- Consumes: `EactivitiesCredentials` type from `lib/eactivities/credentials.ts` (Task 1).
- Produces: `eactivitiesFetch<T>(path: string, apiKey: string): Promise<T>`, `cspPath(path: string, cspCode: string): string` (both **signature changes** — each gains a required parameter, drops its `process.env` read). `EactivitiesProvider`'s constructor becomes `constructor(private credentials: EactivitiesCredentials)` (**signature change** — previously no-arg). `getEvents()`/`getEvent(eventId)`/`getSignup(signupId)` keep their existing signatures; only their bodies change to thread `this.credentials` through.

- [ ] **Step 1: Make the change**

There's no existing test coverage for either file (confirmed: no `tests/unit/eactivities*` or `tests/integration/eactivities*` files touch `client.ts`/`provider.ts` directly before this plan), and the behavior itself (Basic-auth header construction, CSP path prefixing, the no-retry 401/403 policy) is unchanged — only *where the credential values come from* changes. This step is a direct edit, verified by the full test suite in Step 2, not a new TDD cycle.

Rewrite `lib/eactivities/client.ts`:

```ts
import { EactivitiesApiError } from "./types";

const BASE_URL = "https://eactivities.union.ic.ac.uk/API";

export async function eactivitiesFetch<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}`,
      Accept: "application/json",
    },
  });

  if (response.ok) {
    return (await response.json()) as T;
  }

  if (response.status === 401 || response.status === 403) {
    let apiMessage = "";
    try {
      const body = (await response.json()) as { message?: string };
      apiMessage = body.message ?? "";
    } catch {
      // body wasn't JSON — fall through with an empty message
    }
    throw new EactivitiesApiError(response.status, apiMessage);
  }

  throw new Error(
    `eActivities API returned unexpected status ${response.status} for ${path}`
  );
}

export function cspPath(path: string, cspCode: string): string {
  return `/csp/${cspCode}${path}`;
}
```

(Keep every existing doc comment about the no-retry policy and the Basic-auth verification note verbatim — only the `apiKey`/`centre` env-var reads at the top of each function are removed, replaced by the new parameters. `EactivitiesNotConfiguredError` is no longer imported or thrown here — Task 1's credential lookup is now the single place that error can originate from.)

Rewrite `lib/eactivities/provider.ts`:

```ts
import { cspPath, eactivitiesFetch } from "./client";
import type { SignupDetail, WhatsOnEvent, WhatsOnEventDetail } from "./types";
import type { EactivitiesCredentials } from "./credentials";

export class EactivitiesProvider {
  constructor(private credentials: EactivitiesCredentials) {}

  async getEvents(): Promise<WhatsOnEvent[]> {
    return eactivitiesFetch<WhatsOnEvent[]>(
      cspPath("/whatson", this.credentials.cspCode),
      this.credentials.apiKey
    );
  }

  async getEvent(eventId: string): Promise<WhatsOnEventDetail> {
    return eactivitiesFetch<WhatsOnEventDetail>(
      cspPath(`/whatson/${eventId}`, this.credentials.cspCode),
      this.credentials.apiKey
    );
  }

  async getSignup(signupId: string): Promise<SignupDetail> {
    return eactivitiesFetch<SignupDetail>(
      cspPath(`/signups/${signupId}`, this.credentials.cspCode),
      this.credentials.apiKey
    );
  }
}
```

(Keep the existing class-level doc comment verbatim.)

- [ ] **Step 2: Run the full suite to verify nothing broke**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `lib/attendance/actions.ts` and `lib/attendance/sync.ts` (both construct `EactivitiesProvider` with no arguments today — Tasks 3 and 4 fix these) and in `tests/integration/attendance-sync.spec.ts` if it directly imports `EactivitiesProvider`'s type anywhere beyond the `Pick<EactivitiesProvider, "getSignup">` it already uses (check; that `Pick` type doesn't touch the constructor, so it should be unaffected). No errors should appear anywhere else.

- [ ] **Step 3: Commit**

```bash
git add lib/eactivities/client.ts lib/eactivities/provider.ts
git commit -m "feat(eactivities): take credentials as parameters instead of reading env vars"
```

---

### Task 3: `lib/attendance/actions.ts` resolves credentials per call, drops the gate

**Files:**
- Modify: `lib/attendance/actions.ts:1-42` (imports, module-level `provider`, `getEventSignups`, `createSessionFromSignup`)

**Interfaces:**
- Consumes: `getEactivitiesCredentials(clubId)` (Task 1), `EactivitiesProvider(credentials)` (Task 2), `EactivitiesNotConfiguredError` (Task 1).
- Produces: `getEventSignups(clubSlug, eventId)` and `createSessionFromSignup(clubSlug, input)` keep their existing public signatures — no caller-facing change.

- [ ] **Step 1: Write the failing test**

There is no direct integration test for these two Server Actions (both require `requireAdmin`'s real request context, same limitation as every other admin action in this codebase) — this task is verified by `tsc` and a focused manual check instead of a new automated test, consistent with how every other Server-Action-only change in this codebase has been verified. Skip to Step 3.

- [ ] **Step 2: (skipped — no new test for this step; see Step 1)**

- [ ] **Step 3: Write the implementation**

In `lib/attendance/actions.ts`, update the imports and the two functions:

```ts
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import { getEactivitiesCredentials } from "@/lib/eactivities/credentials";
import { EactivitiesNotConfiguredError } from "@/lib/eactivities/types";
import { syncSessionAttendance } from "@/lib/attendance/sync";
import { getSessionWithAttendance, assertSessionBelongsToClub } from "@/lib/attendance/queries";
import { requireAdmin } from "@/lib/auth/require-admin";
import { escapeIlikePattern, normalizeCid } from "@/lib/utils";
import { reapplyWaiversForPerson } from "@/lib/purchase/interface";

// ---------------------------------------------------------------------------
// 3.0 — session creation / signup binding (AC-8)
// ---------------------------------------------------------------------------

export async function getEventSignups(clubSlug: string, eventId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  let provider: EactivitiesProvider;
  try {
    provider = new EactivitiesProvider(await getEactivitiesCredentials(clubId));
  } catch (error) {
    if (error instanceof EactivitiesNotConfiguredError) {
      throw new Error("eActivities isn't available for this club yet — use CSV import instead.");
    }
    throw error;
  }
  const event = await provider.getEvent(eventId);
  return {
    id: event.ID,
    title: event.Title,
    startsAt: event.EventStart,
    signups: event.Signups.map((s) => ({
      id: s.ID,
      title: s.Title,
      attendeesCount: s.AttendeesCount,
      maximumAttendees: s.MaximumAttendees,
    })),
  };
}

const createSessionSchema = z.object({
  eventId: z.string().min(1),
  signupId: z.string().min(1),
  title: z.string().min(1).max(200),
  startsAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
});

export async function createSessionFromSignup(
  clubSlug: string,
  input: z.infer<typeof createSessionSchema>
): Promise<{ sessionId: string }> {
  const { clubId } = await requireAdmin(clubSlug);
  try {
    await getEactivitiesCredentials(clubId);
  } catch (error) {
    if (error instanceof EactivitiesNotConfiguredError) {
      throw new Error("eActivities isn't available for this club yet — use CSV import instead.");
    }
    throw error;
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
    // swallow — non-fatal, see comment above
  }

  return { sessionId: session.id };
}
```

(`createSessionFromSignup` calls `getEactivitiesCredentials(clubId)` up front purely to surface the "use CSV import instead" message immediately, at creation time, rather than letting it only fail silently inside the best-effort `syncSessionAttendance` try/catch below — the actual provider construction for the sync itself happens inside `syncSessionAttendance`, built in Task 4. This means credentials get resolved twice on the happy path for this one function (once here, once inside `syncSessionAttendance`) — an accepted, deliberate redundancy for a clearer error at the right moment, not a bug.)

Remove the now-unused `createAdminClient` import if nothing else in this file uses it (check — `getAttendanceList`/`toggleAttendance` etc. use `createClubScopedClient`, not `createAdminClient`, after Task 3 of the prior plan; confirm with a search before removing the import, since removing a used import would break the build).

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: errors only in `lib/attendance/sync.ts` (Task 4's job) and nowhere else.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance/actions.ts
git commit -m "feat(eactivities): resolve per-club credentials in getEventSignups/createSessionFromSignup, drop the EACTIVITIES_CLUB_SLUG gate"
```

---

### Task 4: `syncSessionAttendance` resolves credentials for the real (non-test) path

**Files:**
- Modify: `lib/attendance/sync.ts:1-6, 104-110` (imports, the `provider` default inside `syncSessionAttendance`)
- Test: `tests/integration/attendance-sync.spec.ts`

**Interfaces:**
- Consumes: `getEactivitiesCredentials(clubId)` (Task 1), `EactivitiesProvider(credentials)` (Task 2).
- Produces: `syncSessionAttendance`'s existing public signature `(sessionId: string, clubId: string, options?: SyncOptions)` is unchanged — only its internal default-provider construction changes.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/attendance-sync.spec.ts`, inside the existing `test.describe("syncSessionAttendance", ...)` block:

```ts
  test("throws EactivitiesNotConfiguredError before making any HTTP call when the club has no eActivities credentials", async () => {
    const sessionId = await createSession(`signup-${crypto.randomUUID()}`);
    sessionIds.push(sessionId);

    // No options.provider override here -- this exercises the REAL
    // credential-resolution path, not a fake. judoClubId is assumed to
    // have no club_credential row at this point in the plan (Task 5,
    // which seeds Judo's real row, runs after this task) -- if that
    // assumption no longer holds when this test runs, swap in a disposable
    // club/session with a guaranteed-absent credential row instead.
    const { EactivitiesNotConfiguredError } = await import("@/lib/eactivities/types");
    await expect(syncSessionAttendance(sessionId, judoClubId)).rejects.toThrow(EactivitiesNotConfiguredError);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/attendance-sync.spec.ts`
Expected: FAIL — `syncSessionAttendance` still constructs a no-arg `EactivitiesProvider()`, which won't compile once Task 2 landed (this confirms the test is wired to the right, now-broken call), or if it somehow still compiles, it would attempt a real HTTP call instead of throwing early.

- [ ] **Step 3: Write the implementation**

In `lib/attendance/sync.ts`, update the imports and the one line inside `syncSessionAttendance`:

```ts
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import { getEactivitiesCredentials } from "@/lib/eactivities/credentials";
```

```ts
export async function syncSessionAttendance(
  sessionId: string,
  clubId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
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

  const provider = options.provider ?? new EactivitiesProvider(await getEactivitiesCredentials(clubId));
  const signup = await provider.getSignup(session.eactivities_signup_id);

  // ... the rest of the function (the Attendees loop, the session/sync_cursor updates, the return) is UNCHANGED from the current file ...
}
```

Note the credential resolution happens AFTER the `SessionNotBoundError`/`SyncDebouncedError` checks, not before — those two checks are cheaper (no network/DB round trip beyond the session row already fetched) and should still fail fast for their own reasons regardless of credential configuration, matching the current file's existing ordering of checks.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/attendance-sync.spec.ts`
Expected: PASS (all tests in this file, including the new one).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && npx playwright test --config=playwright.integration.config.ts`
Expected: fully clean — this was the last file with a deferred compile error from Task 2.

- [ ] **Step 6: Commit**

```bash
git add lib/attendance/sync.ts tests/integration/attendance-sync.spec.ts
git commit -m "feat(eactivities): resolve per-club credentials inside syncSessionAttendance's real (non-test) path"
```

---

### Task 5: Provisioning script + migrate Judo's credentials

**Files:**
- Create: `scripts/set-eactivities-credentials.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks' code — this is a standalone script, mirroring `scripts/create-admin.ts`'s structure.
- Produces: nothing other application code consumes; it's the operational entry point for populating `club_credential` rows.

- [ ] **Step 1: Write the script**

Create `scripts/set-eactivities-credentials.ts`:

```ts
// One-off eActivities credential provisioning -- run manually, not exposed
// via the app. Usage: node scripts/set-eactivities-credentials.ts <club-slug> <api-key> <csp-code>
//
// Requires SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL in .env.local.
// Upserts a club_credential row (provider: 'eactivities') for the given
// club -- re-running this for a club that already has a row updates it in
// place (e.g. to rotate a key), rather than erroring on the primary key.

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not set");

const clubSlug = process.argv[2]?.trim().toLowerCase();
const apiKey = process.argv[3]?.trim();
const cspCode = process.argv[4]?.trim();
if (!clubSlug || !apiKey || !cspCode) {
  console.error("Usage: node scripts/set-eactivities-credentials.ts <club-slug> <api-key> <csp-code>");
  process.exit(1);
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

  const { error: upsertError } = await admin
    .from("club_credential")
    .upsert(
      { club_id: club.id, provider: "eactivities", credentials: { apiKey, cspCode }, updated_at: new Date().toISOString() },
      { onConflict: "club_id,provider" }
    );
  if (upsertError) {
    console.error(`Failed to store eActivities credentials for "${clubSlug}": ${upsertError.message}`);
    process.exit(1);
  }

  console.log(`Stored eActivities credentials for club "${clubSlug}".`);
}

main();
```

(No password/key is printed back — the caller just typed it in as an argument; there's nothing to reveal, unlike `create-admin.ts`'s one-time-generated password.)

- [ ] **Step 2: Verify the script runs against a disposable test case**

Run: `node scripts/set-eactivities-credentials.ts taekwondo test-smoke-key test-smoke-csp`
Expected: `Stored eActivities credentials for club "taekwondo".`

Then verify and clean up manually (this is a real write to the live DB — confirm and delete it immediately after confirming, since Taekwondo doesn't have real eActivities credentials yet and this plan's design doesn't require it to):

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
admin.from('club').select('id').eq('slug', 'taekwondo').single().then(({ data: club }) =>
  admin.from('club_credential').select('credentials').eq('club_id', club.id).eq('provider', 'eactivities').single()
).then(({ data }) => console.log(data));
"
```

Confirm it prints `{ credentials: { apiKey: 'test-smoke-key', cspCode: 'test-smoke-csp' } }`, then delete that row before moving on:

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
admin.from('club').select('id').eq('slug', 'taekwondo').single().then(({ data: club }) =>
  admin.from('club_credential').delete().eq('club_id', club.id).eq('provider', 'eactivities')
).then(() => console.log('cleaned up'));
"
```

- [ ] **Step 3: Commit the script**

```bash
git add scripts/set-eactivities-credentials.ts
git commit -m "feat(eactivities): add scripts/set-eactivities-credentials.ts for per-club credential provisioning"
```

- [ ] **Step 4: Migrate Judo's real credentials (operational step, not a commit)**

This step writes Judo's real, currently-env-var-held secret into the live database — stop and confirm with whoever has access to the current `.env.local`/Vercel env values before running it, since it's a real production write using a real secret, not a disposable test case like Step 2.

Read the current values of `EACTIVITIES_API_KEY` and `EACTIVITIES_CSP_CODE` from `.env.local` (or Vercel's env var settings for production), then run:

```bash
node scripts/set-eactivities-credentials.ts judo <the-real-EACTIVITIES_API_KEY-value> <the-real-EACTIVITIES_CSP_CODE-value>
```

Expected: `Stored eActivities credentials for club "judo".`

- [ ] **Step 5: Verify Judo's flow still works end-to-end**

Manually smoke-test (not an automated test — this is the one place this plan touches real production behavior for the one club that already depends on it): as a Judo admin, use the "New session (eActivities)" flow to list events/signups and create one session from a real signup. Confirm it behaves identically to before this plan (same events show up, same signup creates a session with attendees synced). If it fails, the credential migration (Step 4) is suspect — re-check the values copied from `.env.local` character-for-character before assuming the code itself regressed.

- [ ] **Step 6: Final verification across the whole plan**

Run: `npx tsc --noEmit && npx playwright test --config=playwright.integration.config.ts && npx playwright test tests/unit && npx playwright test tests/e2e`
Expected: everything green.

Run: `grep -rn "EACTIVITIES_API_KEY\|EACTIVITIES_CSP_CODE\|EACTIVITIES_CLUB_SLUG" --include="*.ts" --include="*.tsx" lib app`
Expected: zero matches in application code (these three env vars are now fully unused by the code, even though they may still be *set* in Vercel until an ops follow-up removes them — that removal is explicitly out of this plan's scope, since the code works correctly whether or not they still exist).

## Final Verification

- `npx tsc --noEmit` is clean.
- The full test suite (integration + unit + e2e) is green.
- `grep` confirms no application code reads the three retired env vars.
- Judo's real eActivities flow was manually smoke-tested post-migration and behaves identically to before.
- Taekwondo (or any other club) can be given real eActivities access later with exactly one command: `node scripts/set-eactivities-credentials.ts <slug> <key> <csp>` — no code change required.
