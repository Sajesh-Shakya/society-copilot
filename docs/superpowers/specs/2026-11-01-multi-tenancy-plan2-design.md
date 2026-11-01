# Plan 2: Club-Aware Routing/Auth + the Query-Scoping Sweep — Design

## Context

Plan 1 added the multi-tenancy schema foundation (a `club` table, an `admin` table, `club_id` on all 7 core tables, per-club uniqueness) and shipped safely, but it deliberately didn't touch application code or query logic — it only made the *data model* multi-tenant-ready. A production incident during Plan 1 forced an emergency hotfix (`lib/supabase/default-club.ts`) that hardcodes every insert to the Judo club, just to keep the app working.

The result: the schema can support two clubs, but almost nothing in the app actually *uses* `club_id` on the read side. A full audit (two Explore agents + a design agent) found ~16 real gaps — some are just "the other club's data would be visible," but several are worse: `matchPersonRecord` could misattribute a real purchase to the wrong club's person, `processAutoSends` would email every club's approved chase reminders in one cron pass, `reapply_waivers_for_everyone_with_debt()` is an unscoped bulk *write*, and most by-id actions (`toggleAttendance`, `sendChase`, `changeUploadProduct`, etc.) are cross-tenant IDORs — a Judo admin passing a Taekwondo id would succeed today.

Plan 2's job: give every request a real `clubId` (routing + auth), then use it everywhere that currently doesn't. The user explicitly asked for the isolation fixes to happen here rather than being deferred further.

**Decided, not open:** split into 2a (routing/auth + the guardrail client) then 2b (the scoping sweep + migrations), shipped back-to-back; a temporary `EACTIVITIES_CLUB_SLUG` env var gates eActivities-dependent features to Judo only until Plan 4; composite same-club foreign keys are added as a DB-level backstop; `admin_allowlist` stays alongside the new `admin` table for one release as a rollback safety net. **Hard condition:** no Taekwondo `admin` rows get created until 2b's cross-tenant tests pass — this is what makes the gap between 2a and 2b safe.

## Plan 2a: Club-Aware Routing and Auth

Gives every request a real `clubId`. Mechanical, ~15 files.

**`lib/auth/require-admin.ts`** — `requireAdmin(clubSlug): Promise<{email, clubId, clubName}>`, resolving the club and checking `admin` in one call (same shape already designed in Plan 1's spec). Use an identical error for "unknown club" and "not an admin" so the error can't be used to enumerate club slugs. Add `listAdminClubs(email)` (joins `admin` → `club`) for the post-sign-in redirect and the picker page.

**`lib/auth/actions.ts`** — after `signInWithPassword` succeeds, call `listAdminClubs`: exactly 1 club → redirect to `/club/<slug>/sessions`; 0 → sign out, show unauthorized; >1 → redirect to `/select-club`.

**New `app/select-club/page.tsx`** and **`app/club/[clubSlug]/page.tsx`** (redirects to `.../sessions`).

**Move 8 route files under `app/club/[clubSlug]/`** via `git mv` (the set already identified in Plan 1's spec: `sessions/*`, `admin/*`). Each reads `params` (a Promise), calls `requireAdmin(clubSlug)`, and every hardcoded link within it and in `session-picker.tsx`, `csv-importer.tsx`, `attendance-screen.tsx`, `app/page.tsx`, and `app/auth/callback/route.ts` gets rewritten through one small `clubPath(slug, ...)` helper to avoid string drift. Keep `app/api/sessions/[sessionId]/sync/route.ts` where it is — it's machine-authenticated (`SYNC_TRIGGER_SECRET`), not admin-session-gated, so deriving its club from `session.club_id` is simpler and no less secure than moving it under `/api/club/[slug]/...`.

**`middleware.ts`** (currently matches only `/sessions/:path*` — confirmed by reading it; `/admin/*` relies entirely on each page's own `requireAdmin()` call) — change the matcher to `["/club/:path*", "/select-club"]`.

**Server Actions take `clubSlug` as their first argument**, call `requireAdmin(clubSlug)`, and pass `clubId` down: `lib/attendance/actions.ts`, `lib/csv-import/actions.ts`, `lib/purchase/actions.ts`, `lib/xlsx/uploader.ts`, `lib/chase/actions.ts`, `lib/person/actions.ts`. The ~10 client components that call these actions receive `clubSlug` as a prop from their page — never a raw `clubId` from the client, which would skip the admin check.

**`lib/supabase/club-scoped.ts`** (new) — `createClubScopedClient(clubId)`, replacing `lib/supabase/default-club.ts`. Wraps `createAdminClient()` (reuse `lib/supabase/admin.ts` as-is) with a typed table allowlist (the 7 core tables + `purchase_upload` + the 2 read views), auto-stamping/filtering `club_id` on `select`/`insert`/`upsert`/`update`/`delete`, rejecting an insert/update that tries to set a different `club_id`, and a small RPC registry that injects `target_club_id` for the two functions that need it (`search_person_by_name`, `reapply_waivers_for_everyone_with_debt`) while passing through row-scoped ones unchanged (`toggle_attendance`, `apply_purchase_waiver`, `reapply_waivers_for_person`, `person_outstanding_debt`). Add a grep-based test in `tests/unit` asserting `createAdminClient` is only imported from `lib/supabase/*`, `lib/auth/*`, `app/api/cron/*`, and `scripts/*` — this is what makes the scoping structural instead of remembered per call site.

**`scripts/create-admin.ts`** — usage becomes `<email> <club-slug>`; resolves the club, upserts into `admin`; if the Supabase Auth user already exists, still add the `admin` row (one person administering two clubs is now a normal case) instead of exiting. Continue writing `admin_allowlist` too during this release (per the "keep both tables" decision).

**Migration A** — rewrites the Realtime RLS policy on `attendance_record` (currently checks `admin_allowlist` directly — confirmed by reading `supabase/migrations/20260919131024_attendance_record_authenticated_rls.sql`) to check `admin` scoped by `club_id`, so a new club-aware admin's attendance screen still gets live updates, and a Judo admin can no longer subscribe to Taekwondo's rows.

**The eActivities gate** — a temporary `EACTIVITIES_CLUB_SLUG` env var; any eActivities-dependent page/action refuses a request for a different club's slug, with a message that CSV import is available instead. Delete this gate in Plan 4 once real per-club credentials exist.

## Plan 2b: The Scoping Sweep + Migrations

Threads real `clubId` through every confirmed gap. ~20 files + migrations B–F.

**Migration B (same-club FK guarantee)** — `unique(id, club_id)` on `person`/`session`/`product`/`purchase`, then composite FKs: `attendance_record(person_id, club_id)→person`, `attendance_record(session_id, club_id)→session`, `attendance_record(waived_by_purchase_id, club_id)→purchase`, `purchase(person_id, club_id)→person`, `purchase(product_id, club_id)→product`, `chase_email(person_id, club_id)→person`, `purchase_upload(product_id, club_id)→product`. All current data is Judo-only, so this passes trivially on first application. This is the backstop that turns any missed scoping fix into a loud constraint error instead of silent cross-club corruption.

**Migration C** — `search_person_by_name` gets a required `target_club_id uuid` parameter (its `LIMIT` runs before any post-hoc filter could work, so the club predicate must be inside the function); `toggle_attendance` drops its hardcoded `slug = 'judo'` lookup in favor of `(select club_id from session where id = target_session_id)` — no signature change needed there.

**Migration D** — `outstanding_attendance` and `active_debt_cycle` views both gain a trailing `club_id` column via `create or replace view` (no drop needed, column order preserved); `reapply_waivers_for_everyone_with_debt()` gets a required `target_club_id uuid` parameter (it's a bulk write with no post-hoc filtering option).

**Migration E** — `product`'s uniqueness moves from global `unique(name)` to `unique(club_id, name)`; `lib/purchase/interface.ts`'s upsert conflict target changes to `club_id,name` to match.

**Migration F** — `purchase_upload` gets its own `club_id` (it predates Plan 1 and was missed), backfilled from `product.club_id`, then set `NOT NULL`.

**Group 1 — attendance/person matching:** `lib/attendance/sync.ts` (`syncSessionAttendance` reads `session.club_id`; `findOrCreatePerson`'s cid/email lookups scoped), `lib/attendance/actions.ts` (every by-id action scoped — `toggleAttendance`, `setSessionCancelled`, `addExistingPersonToSession`, `createWalkIn`, `triggerManualSync`, `getAttendanceList`, `createSessionFromSignup`; `searchPeople` passes `clubId` to the now-club-aware RPC), `lib/attendance/queries.ts` (`listRecentSessions`, `getSessionWithAttendance` take `clubId`), `lib/csv-import/importer.ts` (`importAttendanceCsv`/`syncAttendanceCsv` take `clubId`; keep no `requireAdmin()` call here for testability, same as today — tests pass `clubId` explicitly).

**Group 2 — purchase matching/listing:** `lib/purchase/matcher.ts` (`matchPersonRecord`/`matchOrQueue` take `clubId` — all 3 match rules scoped; this is the highest-impact fix, since it's the one that can misattribute real money today), `lib/purchase/interface.ts` (`ingestPurchases`, `rematchUnmatchedPurchases`, `listRecentUploads`, `changeUploadProduct` — also verifying `newProductId` belongs to the club, `undoUpload`, `reapplyWaiversForEveryoneWithDebt` all take `clubId`), `lib/purchase/queries.ts` (`listProducts(clubId)`), `lib/xlsx/uploader.ts` (product check scoped; `purchase_upload` insert stamped with `club_id`).

**Group 3 — chase-email pipeline:** `lib/chase/debt-cycles.ts` (`listActiveDebtCycles(clubId)` — this is what currently lets `generateChaseEmails` mistag a Taekwondo debtor's chase_email as Judo's), `lib/chase/generator.ts`, `lib/chase/send.ts` (`processAutoSends(clubId, adapter)` — this one is a *send* side effect, not just a read), `lib/chase/approval-writer.ts`, `lib/chase/queries.ts` (`countFailedChaseEmails(clubId)`), `app/api/cron/chase-emails/route.ts` (loop every club via the plain admin client, run reapply→generate→auto-send per club inside its own try/catch so one club's failure doesn't block the rest; loop *all* clubs for now, not just ones with `club_credential`, since that table stays empty until Plan 4).

**Group 4 — admin dashboards:** the purchases page, chase-inbox page (plus its person-lookup follow-up query), the unpaid page, and the `/sessions` failed-send badge all move to page-level queries via the scoped client. `lib/person/exempt-writer.ts` scoped too.

**Group 5 — remove the hotfix:** delete `lib/supabase/default-club.ts` and its 5 importers; confirm `grep -r "getDefaultClubId\|slug = 'judo'"` only matches test fixtures and historical migration files afterward.

**Tests:** one cross-tenant integration spec per group — seed matching Taekwondo rows (same CID/email, same product name, an unmatched purchase, a debtor, an approved repeat chase email), assert Judo-scoped calls never see or touch them, assert by-id actions throw on a Taekwondo id. Update the existing specs whose call signatures changed: `person-search`, `chase-generator`, `chase-send`, `ingest-purchases`, `purchase-matcher`, `purchase-upload`, `session-list`, `csv-import`, `attendance-sync`, `purchase-waivers`.

**Only after 2b's cross-tenant tests pass:** run `scripts/create-admin.ts` for the first real Taekwondo admin.

## Execution

Each phase (2a, then 2b) gets its own formal implementation plan via the `writing-plans` skill — 2a is small/mechanical enough for one plan; 2b's size (5 migrations + ~20 files across 5 groups) likely wants its own task breakdown the same way Plan 1 did. Both execute via `subagent-driven-development`, matching Plan 1.

## Verification

- 2a: `tests/e2e/admin-auth-gate.spec.ts` extended to cover an admin of one club refused on the other club's URL, an unknown slug refused, and the multi-club picker; `login-form` test expects redirect to `/club/judo/sessions`.
- 2b: the cross-tenant specs described above, plus the full existing integration suite (currently 97/97, one pre-existing unrelated flake in `person-search.spec.ts` under parallel load) re-run green after every group's changes.
- Before enabling any real Taekwondo admin: manually smoke-test one full flow (tick attendance, import a CSV, approve+send a chase email, ingest a purchase) under `/club/taekwondo/...` with seeded Taekwondo data that intentionally collides with Judo's (same email, same CID, same product name) and confirm no cross-club leakage or action.
