# Navigation Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clicks between admin pages respond instantly (skeletons, pending states, targeted prefetch) and cut the sequential Supabase round trips that precede every page's own data fetch.

**Architecture:** Replace network `auth.getUser()` calls with local JWT verification (`auth.getClaims()`, ES256 keys confirmed), collapse `requireAdmin`'s two sequential lookups into one joined query and memoise it per request with React `cache()`, add `loading.tsx` skeletons so dynamic routes prefetch their shell, add a pending indicator on links, and fully prefetch the session happening "now".

**Tech Stack:** Next.js 16.2.1 App Router (read `node_modules/next/dist/docs/` before writing code — AGENTS.md), `@supabase/ssr`, shadcn/ui, Playwright (unit/e2e/integration configs).

**Spec:** `docs/superpowers/specs/2026-11-13-performance-and-recurring-events-design.md` (Project 1)

## Global Constraints

- All pages stay `export const dynamic = "force-dynamic"`; do not cache business data.
- `requireAdmin` must keep re-checking club-admin membership against the DB on every call (revoking an admin takes effect immediately).
- Unknown club slug and non-admin must return the identical message `"Not authorized for this club."` (`NOT_AUTHORIZED_MESSAGE`).
- Admin emails are compared lowercase.
- Prefetch window is `starts_at − 1h` to `ends_at + 1h`; null `ends_at` is treated as `starts_at + 2h`.
- No new dependencies. Commit steps follow repo convention (`feat(...)`, `fix(...)`, `test(...)`) and end with the attribution line from the session.

## Review Focus

- Expired/invalid/missing JWT: middleware and `requireAdmin` redirect to `/login` (or throw `UnauthorizedError`), never crash with a 500.
- Mixed-case email in the JWT versus lowercase `admin.email`: still authorised.
- Admin row deleted while their JWT is still valid: next `requireAdmin` call refuses.
- Cancelled session inside the time window is not fully prefetched.
- Session exactly 60 min before start / 60 min after end: boundaries inclusive; 61 min: excluded.

## File Structure

- Create `lib/auth/session.ts` — `getSignedInEmail()`: verified email from claims or null.
- Modify `lib/auth/require-admin.ts` — one-query `checkAdminForClub`, cached `requireAdmin`.
- Modify `lib/supabase/middleware.ts`, `middleware.ts` — claims instead of `getUser`.
- Modify `app/page.tsx`, `app/select-club/page.tsx`, `app/club/[clubSlug]/page.tsx` — use `getSignedInEmail`.
- Create `components/ui/skeleton.tsx`, `components/nav/page-skeleton.tsx`, `components/nav/pending-link.tsx`.
- Create `loading.tsx` under each route in `app/club/[clubSlug]/` (sessions, sessions/[sessionId], sessions/new, sessions/import, admin/purchases, admin/unpaid, admin/chase-inbox).
- Create `lib/attendance/event-window.ts`; modify `app/club/[clubSlug]/sessions/page.tsx`.
- Tests: `tests/unit/event-window.spec.ts`, additions to `tests/integration/require-admin.spec.ts`.

---

### Task 1: Baseline and region check

**Files:** Modify `docs/PROJECT_STATUS.md` (add a short "Performance baseline" section).

**Interfaces:** Produces the before-numbers Task 7 compares against.

- [ ] **Step 1: Find both regions.** Vercel: `mcp__vercel__get_project` (project for this repo) → serverless function region (none set in `vercel.json` means the Vercel default). Supabase: `mcp__supabase__get_project_url` project → region via the Supabase MCP `list_projects` (plugin server) or dashboard. Record both.
- [ ] **Step 2: Record baseline.** From `mcp__vercel__get_runtime_logs` (or the dashboard), note the duration of 5 recent `GET /club/judo/sessions` and `/club/judo/admin/purchases` requests. Write the median in `docs/PROJECT_STATUS.md`.
- [ ] **Step 3: Decide on region.** If the regions are on different continents, add `"regions": ["<vercel region nearest the Supabase region>"]` to `vercel.json`; otherwise leave it. Note the decision in `docs/PROJECT_STATUS.md`.
- [ ] **Step 4: Commit** `docs: record navigation-speed baseline and region check`.

### Task 2: Local JWT verification (`getSignedInEmail`) in middleware and pages

**Files:**
- Create: `lib/auth/session.ts`
- Modify: `lib/supabase/middleware.ts`, `middleware.ts`, `app/page.tsx`, `app/select-club/page.tsx`, `app/club/[clubSlug]/page.tsx`
- Test: `tests/e2e/admin-auth-gate.spec.ts` (existing; must stay green)

**Interfaces:**
- Produces: `getSignedInEmail(): Promise<string | null>` — lowercased email from verified claims, `null` when there is no valid session. Never throws for an expired/garbled token.
- Produces: `createClient(request)` in `lib/supabase/middleware.ts` now returns `{ supabaseResponse: NextResponse; email: string | null }` (was `user: User | null`).

- [ ] **Step 1: Read the installed `getClaims` docs** in `node_modules/@supabase/auth-js/dist/main/GoTrueClient.d.ts` (~line 2480–2560) and confirm: it verifies the ES256 signature against the project JWKS locally, and refreshes the session first when the access token is expired. If it does not refresh, keep the middleware's `getUser()` fallback only for the expired case and say so in a code comment.
- [ ] **Step 2: Implement `getSignedInEmail`** in `lib/auth/session.ts` using `createClient` from `lib/supabase/server.ts` and `auth.getClaims()`; return `claims.email?.toLowerCase() ?? null`, and `null` if `error` or no claims.
- [ ] **Step 3: Update `lib/supabase/middleware.ts`** to call `auth.getClaims()` (keep the cookie `setAll` refresh handling and the "do not remove" comment, adjusted) and return `email`. Update `middleware.ts` to redirect to `/login` when `email` is null.
- [ ] **Step 4: Replace the three `supabase.auth.getUser()` page checks** with `getSignedInEmail()`; same redirect behaviour.
- [ ] **Step 5: Run** `npx playwright test tests/e2e/admin-auth-gate.spec.ts` — Expected: all pass (every protected path still redirects an unauthenticated visitor to `/login`).
- [ ] **Step 6: Commit** `perf(auth): verify JWT locally via getClaims instead of a network getUser call`.

### Task 3: One-query, per-request-cached `requireAdmin`

**Files:**
- Modify: `lib/auth/require-admin.ts`
- Test: `tests/integration/require-admin.spec.ts`

**Interfaces:**
- Consumes: `getSignedInEmail()` from Task 2.
- Produces: `checkAdminForClub(email: string, clubSlug: string): Promise<{ clubId: string; clubName: string }>` (signature unchanged) and `requireAdmin(clubSlug: string): Promise<{ email: string; clubId: string; clubName: string }>` (signature unchanged, now wrapped in `React.cache`).

- [ ] **Step 1: Write failing tests** in `tests/integration/require-admin.spec.ts`:
  - `checkAdminForClub accepts a mixed-case email` — insert admin row with lowercase email for judo, call with `"Mixed.Case@Example.test"`-style uppercase variant, expect `{ clubId, clubName: "Judo" }`.
  - `checkAdminForClub gives the identical message for unknown slug and non-admin` — both reject with `UnauthorizedError` and equal `.message === "Not authorized for this club."`.
  - `deleting the admin row makes the next call refuse` — call succeeds, delete the row, call again rejects.
- [ ] **Step 2: Run** `npx playwright test --config=playwright.integration.config.ts require-admin` — the existing suite passes; any new test not yet satisfied fails (the mixed-case test should already pass; if all three pass against the old implementation, keep them as regression pins).
- [ ] **Step 3: Rewrite `checkAdminForClub`** as a single query: `admin.from("admin").select("club_id, club:club_id!inner(id, name, slug)").eq("email", email.toLowerCase()).eq("club.slug", clubSlug).maybeSingle()`; a null result throws `UnauthorizedError(NOT_AUTHORIZED_MESSAGE)`. Handle supabase-js returning the to-one join as an array (existing pattern in `listAdminClubs`).
- [ ] **Step 4: Rewrite `requireAdmin`** to use `getSignedInEmail()` (throw `UnauthorizedError("Not signed in")` on null), then `checkAdminForClub`; wrap the whole function in React `cache` so repeated calls with the same slug in one request run once. Keep `listAdminClubs` unchanged.
- [ ] **Step 5: Run** the integration suite for require-admin and `npx playwright test tests/e2e/admin-auth-gate.spec.ts` — Expected: all pass.
- [ ] **Step 6: Commit** `perf(auth): requireAdmin does one DB lookup and is memoised per request`.

### Task 4: Loading skeletons for every club route

**Files:**
- Create: `components/ui/skeleton.tsx` (shadcn `skeleton`: `animate-pulse rounded-md bg-muted`), `components/nav/page-skeleton.tsx`
- Create: `loading.tsx` in `app/club/[clubSlug]/sessions/`, `sessions/[sessionId]/`, `sessions/new/`, `sessions/import/`, `admin/purchases/`, `admin/unpaid/`, `admin/chase-inbox/`

**Interfaces:**
- Produces: `<PageSkeleton variant="list" | "detail" | "table" | "form" />` in `components/nav/page-skeleton.tsx`; each `loading.tsx` is a default export returning one `PageSkeleton` with the matching variant and the same outer wrapper classes as its page (`mx-auto max-w-2xl px-4 py-6 sm:py-10`, `max-w-3xl` for detail, `max-w-4xl` for purchases) so nothing jumps when data arrives.

- [ ] **Step 1: Read** `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`; confirm `loading.tsx` works with these `force-dynamic` pages and does not break the pages' `redirect()` calls.
- [ ] **Step 2: Add the skeleton primitive and `PageSkeleton`** (heading bar + rows/cards/table rows by variant). Skeletons must be `aria-hidden` with a visually-hidden "Loading…" status.
- [ ] **Step 3: Add the seven `loading.tsx` files**, choosing variants: sessions → list, `[sessionId]` → detail, purchases/unpaid/chase-inbox → table, new/import → form.
- [ ] **Step 4: Run** `npm run build` — Expected: success; `npm run lint` clean.
- [ ] **Step 5: Verify in a production build** (prefetch only runs in production): `npm run build && npm start`, sign in, open `/club/judo/sessions`, throttle the network to "Slow 4G" in devtools, click "Purchases" — the skeleton must appear immediately and be replaced by the page. (No automated test: the e2e suite has no signed-in session; say so in the commit body.)
- [ ] **Step 6: Commit** `feat(ui): loading skeletons for all club routes so dynamic pages prefetch their shell`.

### Task 5: Pending feedback on links

**Files:**
- Create: `components/nav/pending-link.tsx`
- Modify: `app/club/[clubSlug]/sessions/page.tsx` (the six header links and `SessionRow`), `app/club/[clubSlug]/admin/purchases/page.tsx` ("← All sessions" link)

**Interfaces:**
- Produces: `<PendingLink href className prefetch?>{children}</PendingLink>` — a client component wrapping `next/link`'s `Link` plus an inner component using `useLinkStatus()` (must be rendered inside the `Link`) that shows a small `Loader2Icon` spinner (`animate-spin`, `aria-hidden`) while `pending`. `prefetch` is passed through (`boolean | null`).

- [ ] **Step 1: Read** `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-link-status.md` (hook only works inside a `Link` descendant).
- [ ] **Step 2: Implement `PendingLink`.** Keep the existing `Button asChild` look on the header links by passing the same `className`s through; if `Button asChild` + custom child is awkward, render the `Button` inside the `PendingLink` instead.
- [ ] **Step 3: Swap** the plain `Link`s on the sessions page and the purchases back-link for `PendingLink`.
- [ ] **Step 4: Run** `npm run lint && npm run build` — Expected: clean.
- [ ] **Step 5: Commit** `feat(ui): spinner on links while a navigation is pending`.

Note: upload/import buttons already have a loading state (`FilePickerButton isLoading` + `loadingLabel` in `xlsx-uploader.tsx`); confirm `components/attendance/csv-importer.tsx` and `sync-csv-button.tsx` do too, and add one if missing (same component).

### Task 6: Prefetch the session happening now

**Files:**
- Create: `lib/attendance/event-window.ts`
- Test: `tests/unit/event-window.spec.ts`
- Modify: `app/club/[clubSlug]/sessions/page.tsx`

**Interfaces:**
- Produces: `isInPrefetchWindow(args: { startsAt: Date; endsAt: Date | null; cancelledAt: Date | null; now: Date }): boolean`.
- Consumes: `PendingLink`'s `prefetch` prop (Task 5); `SessionListItem.startsAt/cancelledAt` from `lib/attendance/queries.ts` (no `endsAt` yet → pass `null`; Project 3 supplies it).

- [ ] **Step 1: Write failing unit tests** in `tests/unit/event-window.spec.ts` (`now` fixed, starts 18:00, ends 20:00):
  - `true` at 17:00 (exactly 60 min before start) and `false` at 16:59.
  - `true` at 21:00 (exactly 60 min after end) and `false` at 21:01.
  - `endsAt: null` behaves as ends at 20:00 (start + 2h): `true` at 21:00, `false` at 21:01.
  - `cancelledAt` set → `false` even inside the window.
- [ ] **Step 2: Run** `npx playwright test tests/unit/event-window.spec.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement `isInPrefetchWindow`** as a pure function with inclusive boundaries.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Use it in `SessionRow`**: compute with `new Date()` per request and pass `prefetch={inWindow ? true : null}` to its `PendingLink`. Only sessions in the window get full prefetch; all others keep the default.
- [ ] **Step 6: Run** `npm run build` — Expected: success.
- [ ] **Step 7: Commit** `feat(sessions): fully prefetch the session whose time window contains now`.

### Task 7: Measure and report

- [ ] **Step 1:** Ask the user before pushing/deploying (outward-facing). Once a preview or production deploy of this branch exists, repeat Task 1 Step 2 for the same two routes and write the after-numbers beside the baseline in `docs/PROJECT_STATUS.md`.
- [ ] **Step 2:** Run the full suites: `npm run test:unit`, `npm run test:e2e`, `npm run test:integration` — Expected: all pass.
- [ ] **Step 3: Commit** `docs: record navigation-speed results`.
