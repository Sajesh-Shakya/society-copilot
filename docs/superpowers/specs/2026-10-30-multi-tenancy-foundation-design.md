# Multi-Tenancy Foundation — Design

## Context

Society Ops Copilot currently serves exactly one club (Imperial, via a single eActivities account and Pluto account), with zero tenant scoping anywhere in the schema and a flat `admin_allowlist(email)` gating access. This spec makes the app able to serve multiple clubs — logically isolated within one shared Supabase project, no physical per-tenant infrastructure — while laying seams for three follow-on sub-projects that are explicitly **not** built here:

1. Pluggable ingestion adapters (non-eActivities/Pluto sources: other APIs, CSV, manual/paper entry)
2. Payment/product model generalization beyond `product.kind`
3. Per-club UI branding/theming and feature config

Target scale: dozens of clubs, logical isolation acceptable (no club currently requires physically separate infrastructure). Both Imperial societies and clubs at other universities are in scope; the data model stays canonical across both — what varies is ingestion source and credentials, not the schema.

## Schema changes

```sql
create table club (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,        -- URL-safe; used for routing
  created_at timestamptz not null default now()
);

create table admin (
  email text not null,
  club_id uuid not null references club(id),
  added_at timestamptz not null default now(),
  primary key (email, club_id)
);
-- replaces admin_allowlist. Deny-all RLS, service-role-only access — same
-- posture as every other table in this project.

create table club_credential (
  club_id uuid not null references club(id),
  provider text not null check (provider in ('eactivities', 'pluto')),
  credentials jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (club_id, provider)
);
-- deny-all RLS, service-role-only. No extra encryption layer: same trust
-- boundary as admin and chase_email already.
```

`club_id uuid not null references club(id)` is added to every existing table: `person`, `session`, `product`, `purchase`, `attendance_record`, `chase_email`, `sync_cursor`. Several of these are derivable via joins, but `club_id` is denormalized directly onto each row anyway — it's what the query-scoping guardrail (below) filters on, and `purchase.person_id` is nullable until matched, so `purchase` needs its own `club_id` regardless of any join path.

Uniqueness constraints that are currently global become per-club, since two clubs can legitimately collide on these values:

| Table | Current | Becomes |
|---|---|---|
| `person` | `cid unique`, `email unique` | `unique(club_id, cid)`, `unique(club_id, email)` |
| `session` | `eactivities_event_id unique`, `eactivities_signup_id unique` | `unique(club_id, eactivities_event_id)`, `unique(club_id, eactivities_signup_id)` |
| `purchase` | `unique(source, source_row_id)` | `unique(club_id, source, source_row_id)` |
| `sync_cursor` | `primary key(source)` | `primary key(club_id, source)` |

`person.cid` stays nullable — Postgres treats multiple `NULL`s as distinct under a unique constraint, so any number of non-Imperial people with no CID is already handled correctly per club.

No `settings jsonb` column on `club` yet — nothing in this spec reads or writes one; the branding/config sub-project adds it when it has an actual consumer.

### Data migration for existing rows

The app currently has exactly one club's worth of data with no `club_id`. The migration: create one `club` row for the existing club, backfill `club_id` onto every existing row in every table listed above, *then* apply the `not null` constraints and the new composite unique constraints. This must run as one migration, in that order, against existing data — not just a fresh-schema migration.

## Routing: path-based club identification

`/club/[clubSlug]/...` carries club identity in the URL. Rejected subdomain-based routing (`club.yourapp.me`) for this spec: the admin-tool audience doesn't need branded subdomains, wildcard-domain support is a Vercel paid-plan feature (not confirmed available on the current Hobby-tier-looking account), and nothing is lost by starting path-based — once a request resolves to a `clubId`, the rest of the system doesn't care whether that resolution came from a path segment or a `Host` header, so subdomain routing remains a non-breaking future upgrade if a specific club later demands it.

Of the 15 existing route files, 8 move one level deeper under `app/club/[clubSlug]/...` (and `app/api/club/[clubSlug]/...`): `sessions/page.tsx`, `sessions/[sessionId]/page.tsx`, `sessions/new/page.tsx`, `sessions/import/page.tsx`, `admin/unpaid/page.tsx`, `admin/purchases/page.tsx`, `admin/chase-inbox/page.tsx`, `api/sessions/[sessionId]/sync/route.ts`. Nothing is duplicated per club; the slug is a route param, not a file. `app/login/page.tsx`, `app/auth/callback/route.ts`, `app/api/cron/*`, `app/page.tsx`, and `app/layout.tsx` stay where they are — they're club-agnostic (login happens before a club is known; cron jobs loop across clubs internally).

## Admin auth model

```ts
export async function requireAdmin(clubSlug: string): Promise<{ email: string; clubId: string }> {
  const { data: { user } } = await (await createServerClient()).auth.getUser();
  if (!user?.email) throw new UnauthorizedError("Not signed in");
  const email = user.email.toLowerCase();
  const admin = createAdminClient();

  const club = await admin.from("club").select("id").eq("slug", clubSlug).maybeSingle();
  if (!club.data) throw new UnauthorizedError(`Unknown club: ${clubSlug}`);

  const row = await admin.from("admin").select("email")
    .eq("email", email).eq("club_id", club.data.id).maybeSingle();
  if (!row.data) throw new UnauthorizedError(`${email} is not an admin for ${clubSlug}`);

  return { email, clubId: club.data.id };
}
```

Every existing call site changes from `requireAdmin()` to `requireAdmin(clubSlug)`, with `clubSlug` threaded from the page's route param through to the Server Action call. This preserves the existing "re-check on every privileged call" property — the enforcement point stays inside each Server Action, not a layout-level guard.

**Post-login** (`app/auth/callback/route.ts`): look up all `admin` rows for the signed-in email.
- Exactly 1 club → redirect to `/club/[slug]/sessions`.
- 0 clubs → unauthorized page, as today.
- \>1 club → new small picker page (`app/select-club/page.tsx`) listing their clubs.

## Query-scoping guardrail

```ts
// lib/supabase/club-scoped.ts
export function createClubScopedClient(clubId: string) {
  const client = createAdminClient();
  return {
    from: (table) => ({
      select: (cols = '*') => client.from(table).select(cols).eq('club_id', clubId),
      insert: (values) => client.from(table).insert({ ...values, club_id: clubId }),
      update: (values) => client.from(table).update(values).eq('club_id', clubId),
      delete: () => client.from(table).delete().eq('club_id', clubId),
    }),
  };
}
```

Every function in `lib/*/queries.ts` and `lib/*/actions.ts` takes `clubId` (from `requireAdmin()`'s return) and goes through `createClubScopedClient(clubId)` instead of calling `createAdminClient()` directly. This is the real mechanism — not Postgres RLS — matching the app's existing security posture (deny-all RLS, enforcement entirely at the application layer). `club` and `admin` themselves stay on the plain admin client, since they establish club identity rather than being scoped by it.

**Deferred, not built here:** moving to real Postgres RLS keyed off a session claim, as a database-level backstop. Revisit once the schema has proven itself across a non-Imperial club, or if a specific club demands stronger isolation guarantees — not a blocker for dozens of logically-isolated tenants.

## Per-club credentials

`lib/eactivities/client.ts` and `lib/pluto/client.ts` stop reading `EACTIVITIES_API_KEY`-style env vars and instead take a `clubId`, look up `club_credential` for `(clubId, provider)`, and use that club's own key.

## Scheduled jobs become club-aware

The per-session eActivities sync trigger (pg_cron + Edge Function, keyed off `session.starts_at`) needs no loop — it's already per-row, and `session` now carries `club_id`, so it resolves the right credential via that. The two Vercel cron jobs (`eactivities-sync`, `chase-emails`) currently assume one global club; they change to fetch all clubs with a `club_credential` row and loop, catching and logging failures per club so one club's failure doesn't block the rest.

## Non-goals for this spec

- New ingestion adapters beyond eActivities/Pluto (other APIs, CSV, manual/paper entry)
- Payment/product model changes beyond `club_id` scoping
- UI theming, branding, or per-club config beyond what's needed for routing/credentials
- Real Postgres RLS tenant isolation (deferred, see above)
- Per-club email sender identity (chase emails and magic links continue sending from the single existing verified sender for all clubs — this is a branding concern, not a foundation concern)

These are tracked as separate future sub-projects, each getting its own spec once needed.

## Manual steps vs. what's automatable

- **Resend**: nothing required for this spec. No per-club sender identity is being built; the existing single verified sender keeps working for all clubs.
- **Vercel**: nothing required for this spec. Path-based routing needs no new domains or wildcard DNS. `vercel.json`/cron route code changes ship through the normal deploy path.
- **Supabase**: schema migrations (new tables, `club_id` columns, constraint changes, the data backfill) are code, applied via migration files — the Supabase MCP can write and apply these, and testing on a Supabase branch before merging to production is recommended given the data backfill touches existing rows. The one genuinely manual step: **the current `EACTIVITIES_API_KEY` and Pluto credential values need to be supplied** so they can be seeded into the new club's `club_credential` row — secret values generally can't be read back out of Vercel's env store via API, so this needs to come from wherever those values are currently recorded, or a fresh credential if they're not retrievable. Deleting the old env vars after the migration is verified working is a deliberate, confirmed step, not automatic.
