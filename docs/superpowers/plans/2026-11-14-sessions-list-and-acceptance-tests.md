# Sessions List Drop-downs + Signed-in Acceptance Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) The sessions page shows at most 3 upcoming and 3 previous sessions, the rest behind a native drop-down; the per-series "+N more" text goes away. (2) A signed-in Playwright acceptance suite verifies the user-facing behaviour built so far (sign-in, navigation feedback, recurring series, list drop-downs, series delete, purchases re-check) against a throwaway club and admin that exist only for the run.

**Architecture:** A pure `splitSessionsForDisplay` helper decides what is shown vs folded; the page renders folded rows in `<details>`. Acceptance tests live in `tests/acceptance/`, run with their own config (`playwright.acceptance.config.ts`, 1 worker, `npm run dev` web server by default, `ACCEPTANCE_BASE_URL` to target a deployed app), and a global setup/teardown creates then deletes one throwaway `club`, one `admin` row and one auth user via the service-role client. Data a test needs (people, past sessions, purchases) is seeded with the admin client; user-visible behaviour is driven through the UI.

**Tech Stack:** Next.js 16, Playwright, Supabase service-role client (`lib/supabase/admin.ts`), existing server actions.

**Spec:** conversation 2026-11-14 (user: "only show the 3 upcoming events at most and the rest in a drop down … max 3 previous sessions and rest behind a drop down"; "write acceptance tests" for the manual checks). Related: `docs/superpowers/specs/2026-11-13-performance-and-recurring-events-design.md`.

## Global Constraints

- Sessions page sections: **Today** is never folded. **Upcoming**: the 3 soonest across all sessions (series or not), the rest in `<details><summary>Show N more upcoming</summary>`. **Past**: the 3 most recent, the rest in `<details><summary>Show N earlier</summary>`. Order inside each list is unchanged (Upcoming soonest first; Past newest first). Drop-downs are native `<details>` (works in a server component, no JS). Remove `limitUpcomingPerSeries`, `lib/session-series/upcoming.ts`, `tests/unit/upcoming.spec.ts` and any "+N more in this series" text/doc wording.
- Acceptance tests must never touch real clubs' data: everything is created under a throwaway club whose slug is `e2e-<random>`; teardown removes every row created for it (all club-scoped tables, then `admin`, then `club`, then the auth user) even when tests fail; a leftover-sweep at setup removes stale `e2e-*` clubs and `acceptance-*@example.test` users from crashed earlier runs.
- No test asserts timing/performance numbers. No test sends real email or calls eActivities/Resend/Pluto.
- Credentials for the throwaway user are random per run and never logged or committed.
- `npm run test:unit`/`test:e2e`/`test:integration` behave exactly as before (the default config must ignore `tests/acceptance/**`). New script: `npm run test:acceptance`.
- Next.js 16 differs from training data (AGENTS.md): read the relevant doc in `node_modules/next/dist/docs/` before changing page code.
- Commit steps end with the attribution line from the session. Integration/acceptance tests run against the real dev Supabase project and clean up after themselves.

## Review Focus

- A throwaway user/club left behind after a failed test or a crashed run (teardown on failure; stale sweep).
- Tests that pass vacuously: a drop-down test that never asserts the folded rows are inside `<details>`, a delete test that does not assert the kept occurrence survives.
- Date-dependent flakiness: series dates relative to "now" must stay in the right section (Upcoming/Past) on any run date; the clock-change series is asserted from stored UTC instants, not from list placement.
- The acceptance suite accidentally running as part of `npm run test:e2e`/`test:unit` or against production data.
- The `<details>` folding hiding a session that is today, cancelled-but-visible, or the only upcoming one.

## File Structure

- Create `lib/attendance/list-display.ts` — pure `splitSessionsForDisplay`.
- Modify `app/club/[clubSlug]/sessions/page.tsx`; delete `lib/session-series/upcoming.ts`, `tests/unit/upcoming.spec.ts`.
- Create `playwright.acceptance.config.ts`, `tests/acceptance/global-setup.ts`, `tests/acceptance/global-teardown.ts`, `tests/acceptance/support/fixtures.ts` (admin client helpers, seeded-data helpers, `signedInPage` fixture), `tests/acceptance/*.spec.ts`.
- Modify `package.json` (script), `playwright.config.ts` (`testIgnore`), `components/nav/page-skeleton.tsx` and `components/nav/pending-link.tsx` (add `data-testid`s only), `docs/PROJECT_STATUS.md`.

---

### Task 1: Sessions list drop-downs

**Files:**
- Create: `lib/attendance/list-display.ts`; Test: `tests/unit/list-display.spec.ts`
- Modify: `app/club/[clubSlug]/sessions/page.tsx`, `docs/PROJECT_STATUS.md`
- Delete: `lib/session-series/upcoming.ts`, `tests/unit/upcoming.spec.ts`

**Interfaces:**
- Produces: `splitSessionsForDisplay<T>(items: T[], visibleCount: number): { shown: T[]; folded: T[] }` — keeps input order; `shown` is the first `visibleCount` items, `folded` the rest; `visibleCount` ≤ 0 shows none; a list at or under `visibleCount` has an empty `folded`.

- [ ] **Step 1: Write failing unit tests** in `list-display.spec.ts`: 7 items with 3 → shown ids `1,2,3`, folded `4..7` in order; 3 items → folded empty; 0 items; `visibleCount` 0 → all folded; does not mutate the input array.
- [ ] **Step 2: Run** `npx playwright test tests/unit/list-display.spec.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the helper, then update the page: apply it to the already-ordered `upcomingSessions` and `pastSessions` with 3; render `shown` rows as today and a `<details>` (summary text per Global Constraints, muted styling consistent with existing text) containing `SessionRow`s for `folded`; delete the series-limit helper, its test, and the "+N more in this series" rendering; the "No sessions in the last 30 days." empty state is unchanged; Today group untouched. Update `docs/PROJECT_STATUS.md` wording about the Upcoming list.
- [ ] **Step 4: Run** `npm run test:unit`, `npx tsc --noEmit`, `npm run lint`, `npm run build` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sessions): show 3 upcoming and 3 past sessions, rest in a drop-down`.

### Task 2: Acceptance harness and sign-in/navigation spec

**Files:**
- Create: `playwright.acceptance.config.ts`, `tests/acceptance/global-setup.ts`, `tests/acceptance/global-teardown.ts`, `tests/acceptance/support/fixtures.ts`, `tests/acceptance/navigation.spec.ts`
- Modify: `package.json` (`"test:acceptance": "playwright test --config=playwright.acceptance.config.ts"`), `playwright.config.ts` (`testIgnore` also `**/acceptance/**`), `components/nav/page-skeleton.tsx` (`data-testid="page-skeleton"` on the root), `components/nav/pending-link.tsx` (`data-testid="link-pending"` on the spinner)

**Interfaces:**
- Produces (`support/fixtures.ts`): `adminDb` (service-role client), `acceptanceContext(): { clubId: string; clubSlug: string; email: string; password: string }` (read from env vars written by global setup, or a JSON file in the scratch/test-results dir — not committed), `test` extended with a `signedIn` fixture (a page already signed in through the real `/login` form, landing on `/club/{slug}/sessions`), and seed helpers: `seedPerson({ fullName, email, cid? })`, `seedSession({ title, startsAt, endsAt?, seriesId? })`, `seedAttended(sessionId, personId)`, `seedProduct()`, `seedPurchase({...})` — each stamps `club_id` of the throwaway club and records ids for teardown. Global teardown deletes everything for the club.
- Config: `workers: 1`, `fullyParallel: false`, `baseURL` from `ACCEPTANCE_BASE_URL` (default `http://localhost:3000`), `webServer` started only when no `ACCEPTANCE_BASE_URL`, `globalSetup`/`globalTeardown` set, `testDir: ./tests/acceptance`.

- [ ] **Step 1: Write the setup/teardown and fixture, then a failing spec** `navigation.spec.ts`: (a) signing in with the throwaway admin lands on `/club/{slug}/sessions` and shows the "Sessions" heading; (b) with the RSC request for the purchases page delayed (`page.route` with a ~1.5 s delay on requests whose URL matches `/admin/purchases`), clicking the "Purchases" link shows `[data-testid="link-pending"]` and then `[data-testid="page-skeleton"]` before the Purchases heading; (c) a wrong password stays on `/login` with "Invalid email or password."; (d) visiting `/club/{slug}/sessions` signed out redirects to `/login`; (e) the throwaway admin visiting another real club's sessions URL (e.g. `/club/judo/sessions`) is refused (redirected to `/login` or shown not-authorized — assert whatever the app does today).
- [ ] **Step 2: Run** `npm run test:acceptance` — Expected: FAIL on the missing test ids (b) only; (a), (c), (d), (e) should pass once the harness works. Fix harness problems until only the intended failure remains.
- [ ] **Step 3: Add the `data-testid`s**, keep every existing unit/e2e test green.
- [ ] **Step 4: Prove the teardown:** run the suite once, then query the dev DB (admin client in a one-off script or the Supabase MCP) and show zero `club` rows with slug like `e2e-%`, zero `admin` rows for `acceptance-%@example.test`, zero such auth users; run once more with a deliberately failing test (revert after) and show teardown still cleans up. Put the evidence in the report.
- [ ] **Step 5: Run** `npm run test:unit`, `npm run test:e2e`, `npm run test:acceptance`, `npx tsc --noEmit`, `npm run lint` — Expected: PASS.
- [ ] **Step 6: Commit** `test(acceptance): signed-in harness with a throwaway club and admin`.

### Task 3: Series, list and delete acceptance specs

**Files:**
- Create: `tests/acceptance/recurring-series.spec.ts`, `tests/acceptance/sessions-list.spec.ts`, `tests/acceptance/series-delete.spec.ts`

**Interfaces:**
- Consumes: Task 2 fixtures and seed helpers.

- [ ] **Step 1: Write the specs**, each driving the real UI:
  - `recurring-series.spec.ts`: (a) through the form at `/club/{slug}/sessions/recurring`, create a weekly 19:00–20:30 series from `2026-10-19` until `2026-11-02` with a small signup CSV (3 attendees; reuse the repo's CSV header format from `tests/unit/csv-import-parser.spec.ts`); expect a success toast/redirect to the first session; assert via `adminDb` the three stored `starts_at` instants are `2026-10-19T18:00Z`, `2026-10-26T19:00Z`, `2026-11-02T19:00Z` and `ends_at` 90 minutes later; the first session page lists the 3 attendees, the second shows none; (b) a series with end time before start shows the validation message and creates nothing; (c) a CSV with a bad row creates nothing (assert no session rows with that title).
  - `sessions-list.spec.ts`: (a) seed 7 future sessions (dates relative to now: +1d … +7d, distinct titles `Up 1`…`Up 7`), open the list: exactly `Up 1`–`Up 3` are visible outside any `<details>`, `Up 4`–`Up 7` are inside one `<details>` whose summary reads "Show 4 more upcoming", and opening it reveals them (assert with locators scoped to `details`); (b) seed 6 past sessions (−1d … −6d, but not today): 3 newest visible, 3 inside "Show 3 earlier"; (c) with only 2 upcoming sessions no upcoming `<details>` exists; (d) a session starting today is visible outside any `<details>` even when there are many others; (e) no text "more in this series" exists anywhere.
  - `series-delete.spec.ts`: create (via `seedSession` with a shared `series_id`, after creating the `session_series` row through `adminDb`) a 6-week future series; give week 5 an attended record; open week 3, press "Delete this and all later events", assert the preview says the right counts (`3 events will be deleted, 1 kept…` — use whatever exact wording the panel renders, asserted from the panel) and lists week 5 as kept; confirm; assert via `adminDb` weeks 1–2 and 5 remain and 3, 4, 6 are gone, the series row remains, and the app navigated to the sessions list with the result toast. A second test: deleting from week 5 (the one with attendance) with nothing else later keeps it and deletes nothing (confirm button disabled or the panel says there is nothing to delete — assert what the UI does).
- [ ] **Step 2: Run** `npm run test:acceptance` — Expected: PASS. Any failure caused by a real app defect is reported as a finding (do not weaken the assertion): include the failing assertion, what the app did, and the likely cause in the report.
- [ ] **Step 3: Check robustness:** run the suite twice back to back, and once with the system date mentally shifted by reading each date-dependent assertion; state how each test stays correct on any run date.
- [ ] **Step 4: Commit** `test(acceptance): recurring series, session list drop-downs and series delete`.

### Task 4: Purchases re-check acceptance spec and docs

**Files:**
- Create: `tests/acceptance/purchases-recheck.spec.ts`
- Modify: `docs/PROJECT_STATUS.md`

- [ ] **Step 1: Write the spec** (the "Ayaan" scenario): seed a person (no CID mismatch complication: person has CID `06113211`), a product, and an unmatched student purchase whose raw CID is `06113211` (inserted as `match_status = 'unmatched'`, `person_id = null`); sign in, open `/club/{slug}/admin/purchases`, the row shows the `unmatched` badge and the "Re-check 1 unmatched" button; press it; expect the success toast "Matched 1 purchase(s)" and, after refresh, the row's badge reads `cid_matched` and the matched-person name is shown. A second test: an unmatched student purchase whose CID matches nobody stays unmatched and the page shows the "No change — still unmatched" toast.
- [ ] **Step 2: Run** `npm run test:acceptance` — Expected: PASS.
- [ ] **Step 3: Update `docs/PROJECT_STATUS.md`:** an "Acceptance tests" section: what they cover, how to run (`npm run test:acceptance`; `ACCEPTANCE_BASE_URL=https://… npm run test:acceptance` to run against a deployed app using the same Supabase project), that they create and delete a throwaway club/admin/auth user, and an explicit list of what they do NOT verify (Vercel function region vs Supabase region, the plan's `maxDuration` limit, real-export upload timing on the deployed app; the invite/Resend email path), each marked NOT VERIFIED. Replace the earlier manual checklist for the recurring form/delete panel with a pointer to the specs that now cover it.
- [ ] **Step 4: Run all suites:** `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run test:acceptance`, `npm run lint`, `npm run build` — Expected: all pass; name any pre-existing flake (person-search ranking).
- [ ] **Step 5: Commit** `test(acceptance): purchases re-check; document the acceptance suite`.
