# Admin Authentication — Design

## Context

Every Server Action in `lib/attendance/actions.ts`, both session pages
(`app/sessions/new`, `app/sessions/[sessionId]`), and `attendance_record`'s
`anon`-SELECT RLS policy currently trust any caller — there is no admin-auth
system. This was a deliberately tracked gap throughout Phases 0–3
(`specs/attendance-payment-chasing/tasks.md` 3.3a; comments in
`lib/attendance/actions.ts`/`queries.ts`; `app/sessions/[sessionId]/page.tsx`),
not an oversight — `AGENTS.md` said "no production auth unless explicitly
requested" until now. Two automated security reviews flagged it (the second
at CRITICAL), and the user has now explicitly requested it be built.

Scale: one Imperial College Union student society's committee — a handful of
people, no existing user/membership table, no need for role tiers.

## Requirements (from brainstorming)

- Sign-in via Supabase Auth **magic link** (no passwords, no OAuth app to
  register).
- Access restricted to a **manually-maintained allowlist table** — a magic
  link is only sent to (and only means anything for) an email already on it.
  Not domain-restricted: the seed list includes both `@ic.ac.uk` and
  `@imperial.ac.uk` addresses, so a domain check would have wrongly excluded
  real committee emails.
- **Binary access** — anyone on the allowlist has full access; no role tiers.
- Seed data: `ss5123@ic.ac.uk`, `carina.pravinata24@imperial.ac.uk`,
  `g.tyukin25@imperial.ac.uk`. More will be added later via direct SQL — no
  admin-management UI at this scale.

## Architecture

### New table: `admin_allowlist`

```sql
create table public.admin_allowlist (
  email text primary key,
  added_at timestamptz not null default now()
);

alter table public.admin_allowlist enable row level security;
alter table public.admin_allowlist force row level security;
-- Deny-all: no policies for anon/authenticated. Checked only server-side via
-- the admin (secret-key) client — same pattern as every other table.
```

Emails stored lowercase (enforced at write time, not a DB constraint —
there's exactly one write path: manual SQL).

### Sign-in flow

```
Browser                    Server                          Supabase Auth
   |  email                   |                                  |
   |------------------------->| requestMagicLink(email)          |
   |                          |--- check admin_allowlist ------->|
   |                          |    (admin client)                |
   |                          |--- if allowlisted:                |
   |                          |    signInWithOtp(email) -------->|
   |<-- generic response -----|    (same response either way)    |
   |                          |                                   |
   |                          |                    email sent -->[user's inbox]
   |  click link              |                                  |
   |------------------------->| /auth/callback?code=...          |
   |                          |--- exchangeCodeForSession ------>|
   |                          |<-- session, sets cookie ---------|
   |<-- redirect to /sessions/new (cookie set) ------------------|
```

- **`requestMagicLink(email)`** (new Server Action,
  `lib/auth/actions.ts`): looks up `email.toLowerCase()` in
  `admin_allowlist` via the admin client. Returns the *same* generic message
  regardless of whether it matched — an unlisted email gets no link and no
  indication it was rejected, so this route can't be used to enumerate the
  allowlist. Only calls `supabase.auth.signInWithOtp({ email })` (using the
  **server** client — `lib/supabase/server.ts` — since it needs to be able to
  set the resulting cookies) when the email matched.
- **`app/auth/callback/route.ts`** (new): standard `@supabase/ssr` PKCE
  callback — reads `code` from the query string, calls
  `supabase.auth.exchangeCodeForSession(code)` on the server client (sets the
  session cookie via the response), redirects to `/sessions/new`.
- **`app/login/page.tsx`** (new): the email form. Client Component, calls
  `requestMagicLink`, shows the generic confirmation message.

### Route protection: `middleware.ts` (root — new)

Wraps the already-built-but-unused `lib/supabase/middleware.ts` helper
(created weeks ago in the initial Supabase setup, never wired to an actual
`middleware.ts`). Matches `/sessions/:path*`; if `supabase.auth.getUser()`
returns no user, redirects to `/login`. Does **not** gate `/api/cron/*`
(`CRON_SECRET`-protected, machine-to-machine) or
`/api/sessions/[sessionId]/sync` (`SYNC_TRIGGER_SECRET`-protected) — those
already have their own, different, auth mechanism.

### `requireAdmin()` — the actual enforcement point

Middleware alone isn't sufficient: it protects *pages*, but Server Actions
are callable directly and don't reliably run through the same matcher in
every Next.js version, and defense-in-depth means never trusting a layer
above the sensitive operation itself. `lib/auth/require-admin.ts`:

```ts
export async function requireAdmin(): Promise<{ email: string }> {
  const supabase = await createServerClient(); // lib/supabase/server.ts
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) throw new Error("Unauthorized: not signed in");

  const admin = createAdminClient();
  const { data } = await admin
    .from("admin_allowlist")
    .select("email")
    .eq("email", user.email.toLowerCase())
    .maybeSingle();
  if (!data) throw new Error("Unauthorized: not on the admin allowlist");

  return { email: user.email };
}
```

Re-checking the allowlist on every call (not just at login) means **removing**
someone from `admin_allowlist` revokes their access immediately, without
needing to also invalidate their Supabase session — correct revocation
semantics, not just gatekeeping new logins.

Called as the first line of every exported function in
`lib/attendance/actions.ts`, and at the top of both session pages before
calling `getSessionWithAttendance`/`EactivitiesProvider.getEvents()`. Removes
the `SECURITY — TRACKED GAP` comments added earlier (replaced by the actual
check).

### `attendance_record` RLS — closes task 3.3a

```sql
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

Realtime's `postgres_changes` still works: the browser client
(`lib/supabase/client.ts`) already picks up the persisted session
automatically once a user is logged in, so the subscription now connects as
`authenticated` instead of `anon`. `auth.jwt()`/`auth.uid()` are unaffected
by the project's `sb_publishable_`/`sb_secret_` key migration — that changed
the project-level API keys, not per-user session tokens, which remain the
same signed JWTs Supabase Auth has always issued.

## Error handling

- `requireAdmin()` throws a plain `Error` — Server Actions let it propagate
  (Next.js surfaces it as a rejected action call); pages catch it and
  `redirect("/login")` rather than rendering a stack trace.
- `requestMagicLink` never throws for "not on the allowlist" — that's the
  whole point of the generic response; it only throws for genuine
  infrastructure failure (DB unreachable, Supabase Auth error).
- Middleware redirect and `requireAdmin`'s throw are deliberately redundant
  (defense-in-depth) — either one failing open would still leave the other.

## Testing

- `npx tsc --noEmit` / `npm run lint` / `npm run build` — same bar as every
  prior phase.
- `mcp__supabase__execute_sql` smoke test: seed `admin_allowlist` with a test
  email, confirm `requireAdmin`-equivalent query matches; confirm it doesn't
  match an email not on the list.
- `mcp__supabase__get_advisors("security")` after the RLS change.
- Can't fully exercise the magic-link email round-trip without a live
  deploy + real inbox access — same category of limitation as the earlier
  phases' "can't test live eActivities calls." I'll verify everything up to
  and including `signInWithOtp` being called correctly, and flag the actual
  click-through as your manual verification once deployed.

## Scope boundaries (explicit, not silently assumed)

- No sign-out button/flow is specified here — trivial to add
  (`supabase.auth.signOut()`), but wasn't asked for; I'll add a small one
  since its absence would be a real gap in a real login system, and flag it
  as an addition beyond the brainstormed requirements.
- No UI for managing `admin_allowlist` — explicitly deferred, per your
  answer ("I'll add more later" via SQL).
- `app/sessions/new`/`[sessionId]` gain auth; nothing else in the app does
  (there is nothing else — `app/page.tsx` is still the unmodified
  `create-next-app` default).
