# Admin Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the currently-authless attendance feature with Supabase Auth magic-link sign-in, restricted to a manually-maintained allowlist, enforced at every sensitive entry point.

**Architecture:** A new `admin_allowlist` table gates who can ever get a valid session (checked before sending a magic link, and re-checked on every privileged call so removal is instant). `middleware.ts` protects pages; a `requireAdmin()` helper is the real enforcement point, called first inside every Server Action and both session pages. `attendance_record`'s Realtime-enabling RLS policy moves from `anon` to `authenticated`+allowlist.

**Tech Stack:** Next.js App Router (Server Actions, Route Handlers, middleware), Supabase Auth (magic link / OTP, `@supabase/ssr`), Postgres RLS. No unit test runner exists in this repo (Playwright is E2E-only per `AGENTS.md`) — every task's "test" step is one of: a Postgres check via `mcp__supabase__execute_sql`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, or (flagged explicitly) a manual click-through only you can do once deployed. This matches how every prior phase in this codebase was verified — do not add a new test framework as part of this plan.

**Spec:** `docs/superpowers/specs/2026-09-19-admin-auth-design.md`

## Global Constraints

- No role tiers — allowlist membership is binary (on it = full access).
- `admin_allowlist` is not domain-restricted (seed data spans `@ic.ac.uk` and `@imperial.ac.uk`).
- `requestMagicLink` must return an identical response whether or not the email is on the allowlist — never reveal allowlist membership.
- `requireAdmin()` re-checks the DB on every call (not just at login) — removal from `admin_allowlist` must take effect immediately.
- Every new/modified Supabase table or policy goes through `mcp__supabase__apply_migration` and a git-tracked file under `supabase/migrations/`, per this repo's established pattern (see any existing file there for the header-comment style).
- `/api/cron/eactivities-sync` and `/api/sessions/[sessionId]/sync` keep their existing `CRON_SECRET`/`SYNC_TRIGGER_SECRET` auth — `middleware.ts` must not gate them.

---

## Task 1: `admin_allowlist` table + seed data

**Files:**
- Create: `supabase/migrations/20260919075444_create_admin_allowlist.sql`

**Interfaces:**
- Produces: table `public.admin_allowlist(email text primary key, added_at timestamptz)`, seeded with 3 rows.

- [ ] **Step 1: Write the migration file**

```sql
-- Migration: create admin_allowlist table
-- docs/superpowers/specs/2026-09-19-admin-auth-design.md
-- Binary admin access: presence in this table is sufficient, no role column.

create table public.admin_allowlist (
  email text primary key,
  added_at timestamptz not null default now()
);

comment on table public.admin_allowlist is
  'Emails allowed to sign in and use the attendance-tracking admin tools. Checked before sending a magic link (lib/auth/actions.ts) and re-checked on every privileged call (lib/auth/require-admin.ts) so removal takes effect immediately. Not domain-restricted -- seed data spans @ic.ac.uk and @imperial.ac.uk.';

-- RLS: deny-all, same pattern as every other table in this project. Only
-- ever queried via the admin (secret-key) client, server-side.
alter table public.admin_allowlist enable row level security;
alter table public.admin_allowlist force row level security;

insert into public.admin_allowlist (email) values
  ('ss5123@ic.ac.uk'),
  ('carina.pravinata24@imperial.ac.uk'),
  ('g.tyukin25@imperial.ac.uk');
```

- [ ] **Step 2: Apply it**

Run via `mcp__supabase__apply_migration` with `name: "create_admin_allowlist"` and the SQL above as `query`.

- [ ] **Step 3: Verify**

Run via `mcp__supabase__execute_sql`:
```sql
select email from public.admin_allowlist order by email;
```
Expected: exactly the 3 seed rows, lowercase, no others.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260919075444_create_admin_allowlist.sql
git commit -m "feat(auth): add admin_allowlist table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: fix `lib/supabase/middleware.ts` to surface the user, add root `middleware.ts`

The existing `lib/supabase/middleware.ts` (written weeks before this plan) calls
`supabase.auth.getUser()` but discards the result and returns only the
response — it refreshes the session cookie but gives the caller no way to
know if anyone is signed in. This task fixes that (it's the one thing this
whole plan actually needs from it) and wires it into a real `middleware.ts`.

**Files:**
- Modify: `lib/supabase/middleware.ts` (entire file body)
- Create: `middleware.ts` (project root, next to `package.json`)

**Interfaces:**
- Produces: `createClient(request: NextRequest): Promise<{ supabaseResponse: NextResponse; user: User | null }>` (was: `createClient(request): NextResponse`, non-async).

- [ ] **Step 1: Rewrite `lib/supabase/middleware.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const createClient = async (
  request: NextRequest
): Promise<{ supabaseResponse: NextResponse; user: User | null }> => {
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // This also refreshes the auth token — do not remove even though the
  // return value is now used too.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabaseResponse, user };
};
```

- [ ] **Step 2: Create root `middleware.ts`**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  const { supabaseResponse, user } = await createClient(request);

  if (!user) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

// Only /sessions/* needs a logged-in user at the page level. /login and
// /auth/callback must stay reachable while signed out (that's the whole
// point). The API routes under /api/cron and /api/sessions/[id]/sync have
// their own CRON_SECRET/SYNC_TRIGGER_SECRET auth and must not be matched
// here.
export const config = {
  matcher: ["/sessions/:path*"],
};
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/supabase/middleware.ts middleware.ts
git commit -m "feat(auth): wire session-refresh middleware, gate /sessions/*

lib/supabase/middleware.ts previously discarded getUser()'s result, making
it unusable for route protection. Fixed to return the user alongside the
response.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `requireAdmin()` helper

**Files:**
- Create: `lib/auth/require-admin.ts`

**Interfaces:**
- Consumes: `createClient` (async, returns a Supabase client) from `@/lib/supabase/server`; `createAdminClient` from `@/lib/supabase/admin`.
- Produces: `class UnauthorizedError extends Error`; `async function requireAdmin(): Promise<{ email: string }>` — throws `UnauthorizedError` if not signed in or not on `admin_allowlist`, otherwise resolves with the caller's lowercased email. This is what Tasks 5 and 6 call.

- [ ] **Step 1: Write `lib/auth/require-admin.ts`**

```ts
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export class UnauthorizedError extends Error {}

/**
 * The actual enforcement point for admin-only Server Actions and pages.
 * Re-checks admin_allowlist on every call (not just at login) so removing
 * someone from the allowlist revokes access immediately, without needing to
 * also invalidate their Supabase session. See
 * docs/superpowers/specs/2026-09-19-admin-auth-design.md.
 */
export async function requireAdmin(): Promise<{ email: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    throw new UnauthorizedError("Not signed in");
  }

  const email = user.email.toLowerCase();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("admin_allowlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new UnauthorizedError(`${email} is not on the admin allowlist`);
  }

  return { email };
}
```

- [ ] **Step 2: Verify the underlying allowlist query behaves correctly**

Run via `mcp__supabase__execute_sql` (this is the query `requireAdmin` runs, exercised directly since there's no request context to call the TS function outside a running server):

```sql
-- Should match (case-insensitive intent: input is already lowercased by
-- requireAdmin before this query runs, so this checks the table itself).
select email from public.admin_allowlist where email = 'ss5123@ic.ac.uk';

-- Should return zero rows (not on the list).
select email from public.admin_allowlist where email = 'not-an-admin@ic.ac.uk';
```
Expected: first returns 1 row, second returns 0 rows.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/auth/require-admin.ts
git commit -m "feat(auth): add requireAdmin() enforcement helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: magic-link sign-in — actions, login page, callback route

**Files:**
- Create: `lib/auth/actions.ts`
- Create: `components/auth/login-form.tsx`
- Create: `app/login/page.tsx`
- Create: `app/auth/callback/route.ts`
- Modify: `.env.local` (add `NEXT_PUBLIC_SITE_URL`)

**Interfaces:**
- Consumes: `createClient` (async) from `@/lib/supabase/server`; `createAdminClient` from `@/lib/supabase/admin`.
- Produces: `async function requestMagicLink(rawEmail: string): Promise<{ message: string }>`; `async function signOut(): Promise<never>` (redirects, never returns) — both from `lib/auth/actions.ts`, consumed by `components/auth/login-form.tsx` and (Task 5) `components/auth/sign-out-button.tsx`.

- [ ] **Step 1: Add the site URL env var**

Append to `.env.local`:
```
# Used as the magic-link redirect base in dev. In Vercel, set this to the
# real deployed URL (e.g. https://society-ops-copilot.vercel.app).
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

- [ ] **Step 2: Write `lib/auth/actions.ts`**

```ts
"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const emailSchema = z.string().email();

const GENERIC_MESSAGE = "If that email is authorized, a sign-in link has been sent.";

/**
 * Always returns GENERIC_MESSAGE regardless of whether the email is on
 * admin_allowlist — this must never reveal allowlist membership. Only calls
 * signInWithOtp (which sends the actual email) when it matches.
 */
export async function requestMagicLink(rawEmail: string): Promise<{ message: string }> {
  const email = emailSchema.parse(rawEmail).toLowerCase();

  const admin = createAdminClient();
  const { data } = await admin
    .from("admin_allowlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (!data) {
    return { message: GENERIC_MESSAGE };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });
  if (error) throw error;

  return { message: GENERIC_MESSAGE };
}

export async function signOut() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
```

- [ ] **Step 3: Write `components/auth/login-form.tsx`**

```tsx
"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestMagicLink } from "@/lib/auth/actions";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await requestMagicLink(email);
      setMessage(result.message);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={isPending || !email}>
        {isPending ? "Sending…" : "Send sign-in link"}
      </Button>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </form>
  );
}
```

- [ ] **Step 4: Write `app/login/page.tsx`**

```tsx
import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-20">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your committee email — we&apos;ll send a sign-in link.
        </p>
      </div>
      <LoginForm />
    </div>
  );
}
```

- [ ] **Step 5: Write `app/auth/callback/route.ts`**

```ts
import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}/sessions/new`);
    }
  }

  return NextResponse.redirect(`${origin}/login`);
}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean. (The actual magic-link email round-trip needs a live
deploy and a real inbox — flag this to the user as their own manual
verification once deployed; it can't be exercised from here.)

- [ ] **Step 7: Commit**

```bash
git add lib/auth/actions.ts components/auth/login-form.tsx app/login/page.tsx app/auth/callback/route.ts .env.local
git commit -m "feat(auth): add magic-link sign-in flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: gate `lib/attendance/actions.ts` and both session pages with `requireAdmin()`

**Files:**
- Modify: `lib/attendance/actions.ts` (remove the top `SECURITY — TRACKED GAP` comment block; add `await requireAdmin();` as the first line of all 8 exported functions)
- Modify: `lib/attendance/queries.ts` (remove its tracked-gap comment; no code change — `getSessionWithAttendance` is called from the page, which now gates itself in this task)
- Modify: `app/sessions/new/page.tsx`
- Modify: `app/sessions/[sessionId]/page.tsx`
- Create: `components/auth/sign-out-button.tsx`

**Interfaces:**
- Consumes: `requireAdmin`, `UnauthorizedError` from `@/lib/auth/require-admin` (Task 3); `signOut` from `@/lib/auth/actions` (Task 4).

- [ ] **Step 1: Edit `lib/attendance/actions.ts`**

Replace the top comment block (lines 3–14, the `SECURITY — TRACKED GAP...` block) with:

```ts
// Every exported function below calls requireAdmin() first — see
// lib/auth/require-admin.ts and
// docs/superpowers/specs/2026-09-19-admin-auth-design.md. This replaces the
// SECURITY — TRACKED GAP note that was here before admin auth was built.
```

Add the import:
```ts
import { requireAdmin } from "@/lib/auth/require-admin";
```

Add `await requireAdmin();` as the first line of the body of each of these 8
functions (do not change anything else in them):
`getEventSignups`, `createSessionFromSignup`, `toggleAttendance`,
`searchPeople`, `addExistingPersonToSession`, `createWalkIn`,
`triggerManualSync`, `getAttendanceList`.

Example for `toggleAttendance` (apply the same pattern to the other 7):
```ts
export async function toggleAttendance(input: z.infer<typeof toggleSchema>) {
  await requireAdmin();
  const { sessionId, personId, attended } = toggleSchema.parse(input);
  const admin = createAdminClient();
  // ...unchanged...
}
```

- [ ] **Step 2: Edit `lib/attendance/queries.ts`**

Replace:
```ts
// SECURITY — TRACKED GAP: getSessionWithAttendance takes no caller identity
// and does no authorization check — see the note at the top of
// lib/attendance/actions.ts for why, and where this is tracked.
```
with:
```ts
// Caller identity is checked in app/sessions/[sessionId]/page.tsx (the only
// caller) before this runs — see lib/auth/require-admin.ts.
```

- [ ] **Step 3: Edit `app/sessions/new/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import { SessionPicker } from "@/components/attendance/session-picker";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

// This calls the real eActivities API server-side on every request — must
// never be statically prerendered (that would bake in whatever the API
// returned at build time, or fail the build if it's unreachable then).
export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const provider = new EactivitiesProvider();
  const events = await provider.getEvents();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New session</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick the What&apos;s On event, then which of its signups is the attendance
            roster — eActivities doesn&apos;t flag which one, if any, that is.
          </p>
        </div>
        <SignOutButton />
      </div>
      <div className="mt-8">
        <SessionPicker
          events={events.map((e) => ({
            id: e.ID,
            title: e.Title,
            startsAt: e.EventStart,
          }))}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Edit `app/sessions/[sessionId]/page.tsx`**

```tsx
import { notFound, redirect } from "next/navigation";
import { getSessionWithAttendance } from "@/lib/attendance/queries";
import { AttendanceScreen } from "@/components/attendance/attendance-screen";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

// Attendance data changes constantly (ticks, syncs) — must never be
// statically prerendered/cached.
export const dynamic = "force-dynamic";

export default async function SessionAttendancePage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const { sessionId } = await params;
  const session = await getSessionWithAttendance(sessionId);
  if (!session) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <AttendanceScreen session={session} />
    </div>
  );
}
```

- [ ] **Step 5: Write `components/auth/sign-out-button.tsx`**

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";

export function SignOutButton() {
  return (
    <Button variant="ghost" size="sm" onClick={() => signOut()}>
      Sign out
    </Button>
  );
}
```

- [ ] **Step 6: Add the sign-out button to the attendance screen header too**

In `components/attendance/attendance-screen.tsx`, import
`SignOutButton` from `@/components/auth/sign-out-button` and place it next
to the existing "Sync now" button in the header `<div className="flex items-start justify-between gap-4">` block (add it as a sibling of the "Sync now" `<Button>`, inside a small flex wrapper so both buttons sit together):

```tsx
<div className="flex items-center gap-2">
  <Button variant="outline" onClick={handleSync} disabled={isSyncing}>
    {isSyncing ? "Syncing…" : "Sync now"}
  </Button>
  <SignOutButton />
</div>
```
(replacing the standalone "Sync now" `<Button>` that's currently there).

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean. `npm run build` additionally confirms `/sessions/new`
and `/sessions/[sessionId]` still build as dynamic routes (not prerendered)
— check the build output's route table like in earlier phases.

- [ ] **Step 8: Commit**

```bash
git add lib/attendance/actions.ts lib/attendance/queries.ts app/sessions/new/page.tsx "app/sessions/[sessionId]/page.tsx" components/auth/sign-out-button.tsx components/attendance/attendance-screen.tsx
git commit -m "feat(auth): gate attendance actions and pages behind requireAdmin()

Replaces the SECURITY — TRACKED GAP comments (flagged by two security
reviews) with an actual enforcement point.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `attendance_record` RLS — authenticated + allowlist, closes tasks.md 3.3a

**Files:**
- Create: `supabase/migrations/<timestamp>_attendance_record_authenticated_rls.sql` (generate the timestamp at execution time with `date -u +%Y%m%d%H%M%S`, same convention as every prior migration in this repo)
- Modify: `specs/attendance-payment-chasing/tasks.md` (check off `3.3a`)

**Interfaces:**
- None — this is a policy change only, no new function signatures.

- [ ] **Step 1: Write the migration**

```sql
-- Migration: attendance_record RLS -> authenticated + allowlist
-- Closes specs/attendance-payment-chasing/tasks.md task 3.3a
-- docs/superpowers/specs/2026-09-19-admin-auth-design.md
--
-- Replaces the anon-SELECT policy (needed before real auth existed, so
-- Realtime's postgres_changes could reach the browser at all) with a policy
-- scoped to authenticated admins. The browser client (lib/supabase/client.ts)
-- already picks up the signed-in user's session automatically, so the
-- Realtime subscription now connects as `authenticated` instead of `anon`.
-- auth.jwt()/auth.uid() are unaffected by this project's sb_publishable_/
-- sb_secret_ key migration -- that changed the project-level API keys, not
-- per-user session tokens, which remain ordinary Supabase Auth JWTs.

drop policy attendance_record_select_anon on public.attendance_record;

create policy attendance_record_select_authenticated_admin on public.attendance_record
  for select
  to authenticated
  using (
    exists (
      select 1 from public.admin_allowlist
      where email = lower((select auth.jwt() ->> 'email'))
    )
  );
```

- [ ] **Step 2: Apply it**

Run via `mcp__supabase__apply_migration` with `name:
"attendance_record_authenticated_rls"` and the SQL above as `query`.

- [ ] **Step 3: Verify**

Run via `mcp__supabase__get_advisors` with `type: "security"`. Expected: no
new findings introduced by this migration (the pre-existing `rls_auto_enable`
WARN, the `pg_net`/`pg_trgm`-in-public WARNs, and the deny-all INFOs on the
other tables are all unrelated and unaffected — do not attempt to fix those
here, out of scope for this task).

Also run via `mcp__supabase__execute_sql` to confirm the old policy is
actually gone and the new one is in place:
```sql
select policyname, roles, cmd from pg_policies where tablename = 'attendance_record';
```
Expected: `attendance_record_select_authenticated_admin` present with
`roles = {authenticated}`; `attendance_record_select_anon` absent.

- [ ] **Step 4: Check off task 3.3a**

In `specs/attendance-payment-chasing/tasks.md`, change the `3.3a` line from
`- [ ]` to `- [x]` (it currently starts with `- [ ] 3.3a **TRACKED GAP, not
an oversight:**`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/ specs/attendance-payment-chasing/tasks.md
git commit -m "feat(auth): scope attendance_record Realtime RLS to authenticated admins

Closes tasks.md 3.3a.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage:** magic link ✓ (Task 4), allowlist table not domain-restricted ✓ (Task 1), binary access (no role column anywhere) ✓, seed emails ✓ (Task 1), middleware ✓ (Task 2, plus the pre-existing helper bug fix the spec called out), `requireAdmin()` re-checked per-call ✓ (Task 3), gating every action/page ✓ (Task 5), RLS policy swap closing 3.3a ✓ (Task 6), sign-out (spec's explicitly-flagged addition beyond the brainstormed requirements) ✓ (Task 5).

**Placeholder scan:** none found — every step has real, complete code.

**Type consistency:** `requireAdmin(): Promise<{ email: string }>` (Task 3) is the signature every later task imports and calls the same way; `UnauthorizedError` is the one exception type checked for in Task 5's `catch` blocks — no mismatched names between tasks.
