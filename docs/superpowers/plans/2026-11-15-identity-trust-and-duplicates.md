# Identity Trust and Duplicates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CID write follows one trust ranking (SSO > purchase > walk-in) with an audit trail, disagreements are reviewable, unmatched purchases can be matched by hand, same-name people are listed, and walk-in input is validated.

**Architecture:** A pure rule `decideCidEvidence` plus one DB-writing `applyCidEvidence` (and a batched variant for the CSV path) are the only places a CID is written. A new `person.cid_source` column carries provenance; `person_identity_conflict` records overwrites/flags/ignores. Review page and manual-match panel are server components + server actions on top of those.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` first), Supabase (service-role scoped client), Zod, Playwright (unit / integration / acceptance configs).

**Spec:** `docs/superpowers/specs/2026-11-14-identity-trust-and-duplicates-design.md` (approved). Conflicts inside this plan resolve against it.

## Global Constraints

- Source ranks: `sso` (3) > `purchase` (2) > `walk_in` (1). CSV import and live eActivities sync are both `sso`.
- Decision table for different CIDs: higher → `overwrite` (record `overwritten`); equal → `flag` (record `flagged`, open); lower → `ignore` (record `ignored`). Null existing CID → `set`. Same CID → `confirm` (raise stored source if incoming outranks). Existing CID with null source → treated as `sso`.
- A CID already owned by another person is never written by an automatic path: record a `flagged` conflict with `other_person_id`.
- `flagged`/`ignored` conflicts are unique per (club_id, person_id, incoming_cid, incoming_source); a dismissed one stays dismissed. `overwritten` rows are never deduplicated.
- The automatic purchase matching rules (CID → student stop → email → unique name) must not change. Walk-in lookup stays CID then email, never name.
- Walk-in validation (shared Zod schema, client and server): CID optional, trimmed, `^\d{7,8}$`, 7 digits normalised via `normalizeCid`, error text exactly `CID is 8 digits, or 7 if you leave off the leading 0`; full name ≥ 2 words, each containing a letter, internal whitespace collapsed, error text exactly `Enter first name and surname`; email valid.
- New tables: same-club composite FKs, RLS enabled + forced deny-all, added to `CLUB_SCOPED_TABLES` in `lib/supabase/club-scoped.ts`. Migration is additive; filename `supabase/migrations/20261115090000_identity_trust.sql`.
- Server actions: `requireAdmin(clubSlug)` first; files marked `"use server"` export only async functions (pure helpers live in non-action modules); never surface raw DB errors to the UI.
- PostgREST: `.in()` lists ≤ 100 ids (use `lib/chunk.ts`); reads over 1000 rows use `fetchAllPages`.
- The controller (not implementers) applies the migration to the dev Supabase project, after asking the user.

## Review Focus

- Same CID typed by a walk-in as one already held by someone else → flagged duplicate, no unique-violation crash (Task 3 test).
- CSV file whose rows swap CIDs between two people → import completes, no unique violation, later rows see earlier overwrites (Task 5 test).
- Re-importing the same CSV / re-running sync twice → no new conflict rows for flagged/ignored (Tasks 3, 5 tests).
- Walk-in CID with spaces inside, 9 digits, or letters → rejected; `  6113211 ` → stored `06113211` (Task 1 test).
- Manual match on a purchase already matched, or from another club, is refused (Task 6 test).

## File Structure

- Create `lib/identity/cid-rule.ts` — pure rule, ranks, types.
- Create `lib/identity/walk-in-schema.ts` — shared Zod schema.
- Create `lib/identity/conflicts.ts` — `recordConflict`, conflict row types, dedup handling.
- Create `lib/identity/apply-cid-evidence.ts` — `applyCidEvidence`, `applyCidEvidenceBatch`.
- Create `lib/identity/suggestions.ts` — `suggestPersonsForPurchase`.
- Create `lib/identity/match-purchase.ts` (writer) and `lib/identity/actions.ts` (`"use server"`: `matchPurchaseToPerson`, `resolveConflict`, `dismissSameNameGroup`).
- Create `lib/identity/review-queries.ts` — open conflicts, recent changes, same-name groups, incomplete names, open-conflict count.
- Create `app/club/[clubSlug]/admin/people-review/{page,loading}.tsx`, `components/identity/{conflict-list,same-name-groups,match-panel}.tsx`.
- Modify `lib/attendance/actions.ts` (createWalkIn), `lib/attendance/sync.ts`, `lib/csv-import/importer.ts`, `lib/purchase/person-index.ts` (add `cidSourceById`), `components/attendance/add-attendee.tsx`, `components/purchase/purchases-table.tsx`, `app/club/[clubSlug]/admin/purchases/page.tsx`, `app/club/[clubSlug]/sessions/page.tsx` (link + badge), `lib/supabase/club-scoped.ts`, `docs/PROJECT_STATUS.md`.
- Tests: `tests/unit/{cid-rule,walk-in-schema}.spec.ts`, `tests/integration/{identity-schema,apply-cid-evidence,identity-walk-in,identity-sync,identity-csv,identity-match-purchase,identity-review}.spec.ts`, `tests/acceptance/identity.spec.ts`.

---

### Task 1: Pure rule and walk-in schema

**Files:** Create `lib/identity/cid-rule.ts`, `lib/identity/walk-in-schema.ts`; tests `tests/unit/cid-rule.spec.ts`, `tests/unit/walk-in-schema.spec.ts`.

**Interfaces:**
- Produces:
  - `type CidSource = 'sso' | 'purchase' | 'walk_in'`; `CID_SOURCE_RANK: Record<CidSource, number>`; `outranks(a: CidSource, b: CidSource): boolean`.
  - `type CidDecision = { kind: 'set' } | { kind: 'confirm'; raiseSourceTo: CidSource | null } | { kind: 'overwrite' } | { kind: 'flag'; otherPersonId?: string } | { kind: 'ignore' }`.
  - `decideCidEvidence(existing: { cid: string | null; source: CidSource | null }, incoming: { cid: string; source: CidSource }, holder?: { personId: string } | null): CidDecision` — `holder` is another person who already owns `incoming.cid`; when the result would be `set` or `overwrite` and a holder exists, return `{ kind: 'flag', otherPersonId }` instead.
  - `walkInSchema` (Zod: `sessionId` uuid, `email`, `fullName`, `cid` optional) and `type WalkInInput`; `cid` output is normalised to 8 digits, `fullName` output has collapsed whitespace; exported message constants `CID_ERROR`, `NAME_ERROR`.

- [ ] **Step 1: Write failing unit tests.** `cid-rule.spec.ts`: exhaustive truth table — for each of the 3×3 (existing source × incoming source) pairs with different CIDs assert overwrite/flag/ignore per the Global Constraints; null existing → `set`; same CID with incoming higher → `confirm` with `raiseSourceTo` = incoming source, equal/lower → `raiseSourceTo: null`; existing cid with `source: null` behaves as `sso` (walk-in incoming with different CID → `ignore`, sso incoming → `flag`); holder present turns `set`/`overwrite` into `flag` with `otherPersonId`, but leaves `ignore` and `confirm` unchanged. `walk-in-schema.spec.ts`: `'6113211'` → `'06113211'`; `' 06113211 '` ok; `'03079021'` ok; `'123456'`, `'123456789'`, `'0611 3211'`, `'0307902x'` rejected with `CID_ERROR`; empty/undefined cid ok; `'Sean'` rejected with `NAME_ERROR`; `'  Sean   Rawlins '` → `'Sean Rawlins'`; `'1 2'` rejected (no letters); invalid email rejected.
- [ ] **Step 2:** `npx playwright test tests/unit/cid-rule.spec.ts tests/unit/walk-in-schema.spec.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement both modules as pure code (no I/O) per the interfaces. The schema reuses `normalizeCid` from `lib/utils.ts`.
- [ ] **Step 4:** Rerun the command — Expected: PASS.
- [ ] **Step 5:** Commit `feat(identity): CID trust rule and walk-in schema`.

---

### Task 2: Migration, scoped tables, schema test

**Files:** Create `supabase/migrations/20261115090000_identity_trust.sql`, `tests/integration/identity-schema.spec.ts`; modify `lib/supabase/club-scoped.ts`.

**Interfaces:**
- Produces tables/columns exactly as in the spec's Storage section: `person.cid_source`; `person_identity_conflict`; `person_duplicate_dismissal`; `purchase.manual_matched_by/at`. Plus a unique index on `person_identity_conflict (club_id, person_id, incoming_cid, incoming_source) WHERE outcome IN ('flagged','ignored')`, and `person_identity_conflict (club_id, status)` index. `CLUB_SCOPED_TABLES` gains `person_identity_conflict`, `person_duplicate_dismissal`.

- [ ] **Step 1: Write the failing integration test** (follow `tests/integration/session-series-schema.spec.ts` for harness): inserting a person with `cid_source = 'bogus'` fails; a conflict row with a person from another club fails (composite FK); two `flagged` conflicts with identical (club, person, incoming cid, incoming source) → second fails with code 23505, but two `overwritten` ones succeed; a `person_duplicate_dismissal` duplicate (club, name_key, members_hash) fails; scoped client can read/write both new tables.
- [ ] **Step 2:** Run it — Expected: FAIL (tables missing). (Needs the migration applied; run after Step 4.)
- [ ] **Step 3:** Write the migration. Backfill uses spec rule: `cid is null` → null; `identity_confidence = 'provisional'` OR (person has ≥1 attendance_record and none with source in ('signup_sync','csv_import')) → `walk_in`; else `sso`. RLS enable+force on new tables; same-club FKs `(person_id, club_id)` and `(other_person_id, club_id)` to `person (id, club_id)`. Status default: app sets it (`open` for flagged, `resolved` otherwise). Add the two tables to `CLUB_SCOPED_TABLES`.
- [ ] **Step 4:** STOP — report to the controller, who asks the user and applies the migration to the dev project. Then run the test — Expected: PASS. Controller also checks the backfill: count by `cid_source`, and that person 06113211-style walk-in-only people are `walk_in`.
- [ ] **Step 5:** Commit `feat(identity): cid_source, conflict log and dismissal tables`.

---

### Task 3: Conflict recording and `applyCidEvidence`

**Files:** Create `lib/identity/conflicts.ts`, `lib/identity/apply-cid-evidence.ts`; test `tests/integration/apply-cid-evidence.spec.ts`.

**Interfaces:**
- Consumes: Task 1 rule; Task 2 tables.
- Produces:
  - `type IdentityOutcome = 'overwritten' | 'flagged' | 'ignored'`.
  - `recordConflict(scoped, row: { personId; existingCid: string | null; existingSource: CidSource | null; incomingCid: string; incomingSource: CidSource; otherPersonId?: string | null; outcome: IdentityOutcome }): Promise<void>` — sets status `open` for `flagged`, else `resolved`; for `flagged`/`ignored` a 23505 unique violation is swallowed (dedup).
  - `applyCidEvidence(scoped: ScopedClient, personId: string, cid: string, source: CidSource): Promise<{ decision: CidDecision['kind']; cidChanged: boolean }>` — loads the person (`cid`, `cid_source`) and any other holder of `cid` in the club, calls `decideCidEvidence`, writes (`set`/`overwrite`: update `cid` + `cid_source`; `confirm`: raise `cid_source` only when `raiseSourceTo`), records conflicts for overwrite/flag/ignore. A 23505 on the person update (race) downgrades to a recorded `flagged` and returns `{ decision: 'flag', cidChanged: false }`.

- [ ] **Step 1: Write failing tests** (throwaway club via existing integration helpers): null→set writes cid+source; walk_in CID then sso evidence → overwritten, conflict row has old/new values and `resolved`; sso then purchase → ignored, one row, calling twice still one row; sso vs sso different → flagged open, twice → one row; incoming CID owned by another person → flagged with `other_person_id`, no CID change, no throw; same CID with higher source raises `cid_source`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement per interfaces.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit `feat(identity): applyCidEvidence with conflict recording`.

---

### Task 4: Walk-in and live sync writers + form validation

**Files:** Modify `lib/attendance/actions.ts` (createWalkIn), `lib/attendance/sync.ts` (findOrCreatePerson), `components/attendance/add-attendee.tsx`; tests `tests/integration/identity-walk-in.spec.ts`, `tests/integration/identity-sync.spec.ts` (extend existing `attendance-sync.spec.ts` patterns).

**Interfaces:**
- Consumes: `walkInSchema`, `applyCidEvidence`.
- Behaviour: `createWalkIn` parses with the shared `walkInSchema` (replacing the local one); existing person found by CID then email: if a CID was given call `applyCidEvidence(…, 'walk_in')` (replaces the backfill-only block); new person inserted `provisional` with `cid_source = 'walk_in'` when a CID was typed. `findOrCreatePerson` in sync: email match with differing/missing CID calls `applyCidEvidence(…, 'sso')` (replaces backfill); new people get `cid_source = 'sso'` when CID present. CID-matched people need no call. Form: validate with the same schema before submit, show messages inline, disable submit while invalid; the generic failure toast stays for non-validation errors.

- [ ] **Step 1: Write failing tests.** Walk-in: `'6113211'` creates person with cid `06113211`, source `walk_in`; `'Sean'` name rejected; bad CID rejected; walk-in with email of an sso-source person but a different CID → CID unchanged, one `ignored` conflict; walk-in with an email of a CID-less person fills CID with source `walk_in`; walk-in CID owned by someone else → reuses that person (existing CID-first behaviour), no conflict. Sync: attendee whose email matches a `walk_in`-source person with a wrong CID → CID overwritten, conflict `overwritten`; matches an `sso` person with different CID → flagged; second run adds no extra rows.
- [ ] **Step 2:** Run both specs — Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `"use server"` rule: do not export the schema from `actions.ts`.
- [ ] **Step 4:** Run both specs plus `tests/integration/attendance-toggle.spec.ts` — Expected: PASS.
- [ ] **Step 5:** Commit `feat(identity): rank-aware walk-in and live sync, walk-in validation`.

---

### Task 5: Bulk CSV path

**Files:** Modify `lib/purchase/person-index.ts` (add `cidSourceById: Map<string, CidSource | null>`; `loadPersonIndex` selects `cid_source`; `PersonIndexRow` gains `cid_source`), `lib/csv-import/importer.ts` (`resolvePeopleForRows`), add `applyCidEvidenceBatch` to `lib/identity/apply-cid-evidence.ts`; tests `tests/unit/person-index.spec.ts` (extend), `tests/integration/identity-csv.spec.ts`.

**Interfaces:**
- Consumes: Task 1 rule, Task 3 `recordConflict` semantics.
- Produces: `applyCidEvidenceBatch(scoped, ops: Array<{ personId: string; cid: string; source: CidSource; decision: CidDecision; existing: { cid: string | null; source: CidSource | null } }>): Promise<void>` — applies in two phases: first all updates that vacate a CID (overwrites where another pending op will claim the old value, or clearing), then claims; conflict rows are bulk-inserted after filtering out keys already present in the table (one `select` of the club's `flagged`/`ignored` keys) and duplicates within the batch; a residual 23505 on any single update downgrades that row to a `flagged` conflict, never aborting the import.
- `resolvePeopleForRows`: for email-matched rows with a CID (and CID-matched rows need nothing) evaluate `decideCidEvidence` in memory against `index` (source `sso`), updating `index.cidById/byCid/cidSourceById` as it goes (a row's overwrite is visible to later rows; holder lookup = `index.byCid`); new people inserted with `cid_source = 'sso'` when a CID is present. Query count must stay constant in row count (no per-row queries): keep the existing shape.

- [ ] **Step 1: Write failing tests.** Unit: `buildPersonIndex` populates `cidSourceById`. Integration: Ayaan scenario — person walk_in `03079021`, CSV row same email with `06113211` → CID replaced, source `sso`, one `overwritten` conflict; CSV row for an sso person with a different CID → flagged, CID unchanged; swap file (A has B's CID and B has A's, both walk_in) → completes without error and ends in a consistent state with no duplicate CIDs; second import of the same file → no new `flagged`/`ignored` rows; CSV row whose CID is held by a different person and whose email matches someone else → flagged with `other_person_id`; 200-row import still passes the existing performance assertions in `csv-import.spec.ts`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement per interfaces.
- [ ] **Step 4:** Run `tests/unit/person-index.spec.ts tests/integration/identity-csv.spec.ts tests/integration/csv-import.spec.ts tests/integration/ingest-purchases.spec.ts tests/integration/purchase-matcher.spec.ts` — Expected: PASS.
- [ ] **Step 5:** Commit `feat(identity): rank-aware bulk CSV import`.

---

### Task 6: Manual purchase match with suggestions

**Files:** Create `lib/identity/suggestions.ts`, `lib/identity/match-purchase.ts`, `lib/identity/actions.ts` (initially `matchPurchaseToPerson` only), `components/identity/match-panel.tsx`; modify `components/purchase/purchases-table.tsx`, `app/club/[clubSlug]/admin/purchases/page.tsx`; tests `tests/integration/identity-match-purchase.spec.ts`.

**Interfaces:**
- Consumes: `applyCidEvidence`, `decideCidEvidence`, `reapplyWaiversForPerson`, existing `searchPeople`.
- Produces:
  - `matchPurchaseToPerson(clubId: string, purchaseId: string, personId: string, options: { adoptCid: boolean }): Promise<{ matched: true; cid: { decision: CidDecision['kind'] | 'none' } }>` in `match-purchase.ts` (no `requireAdmin`, testable); throws a plain Error (`Purchase is not unmatched`, `Purchase not found`, `Person not found`) when the purchase/person is missing from the club or the purchase is not `unmatched`. Sets `person_id`, `match_status = 'manual_matched'`, `is_student` from `raw_member_type` via `isStudentMemberType`, `manual_matched_by` (admin email), `manual_matched_at`; then `reapplyWaiversForPerson`; if `adoptCid` and `raw_cid`, `applyCidEvidence(…, normalizeCid(raw_cid), 'purchase')`. Signature carries `matchedBy: string` as a trailing argument.
  - `"use server"` wrapper `matchPurchaseToPerson(clubSlug, purchaseId, personId, options)` in `actions.ts` (name it `matchPurchaseToPersonAction` to avoid clashing; only export async functions) that calls `requireAdmin`, validates ids with Zod, maps errors to user-safe messages.
  - `suggestPersonsForPurchase(clubId, purchaseId): Promise<Array<{ personId; fullName; email; cid: string | null; cidSource: CidSource | null; cidEffect: 'set' | 'overwrite' | 'flag' | 'ignore' | 'confirm' | 'none' }>>` — candidates by exact case-insensitive email, then unique full-name match; `cidEffect` from the pure rule with source `purchase` (`'none'` if the purchase has no CID). Also exposed as a server action `suggestPersonsAction(clubSlug, purchaseId)`.
- UI: each unmatched row in `PurchasesTable` gets a "Match…" button opening `MatchPanel` inline (suggestions loaded on open, a search box using `searchPeople`, checkbox "Use this purchase's CID for them" defaulting on when `cidEffect` is `set` or `overwrite`, confirm button, toast on success; on `flag`/`ignore` the toast says the CID conflict was recorded). `page.tsx` passes `rawMemberType`-free data only; add nothing the table does not need. "Re-check unmatched" unchanged.

- [ ] **Step 1: Write failing tests.** Writer: matches an unmatched purchase → status `manual_matched`, audit columns set, waiver applied (reuse the waiver fixture pattern from `purchase-waivers.spec.ts`); with `adoptCid` on a walk_in-source person → CID becomes the purchase's, source `purchase`, one `overwritten` conflict; with `adoptCid` and the person holding an sso CID → CID unchanged, match still stands, `flagged` conflict; `adoptCid` false → no CID work; already-matched purchase refused; purchase or person from another club refused; rematch (`rematchUnmatchedPurchases`) never changes a `manual_matched` row. Suggestions: email match listed first with correct `cidEffect`; two same-name people → no name suggestion.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement writer, suggestions, action, panel and table wiring.
- [ ] **Step 4:** Run the new spec and `tests/integration/purchase-waivers.spec.ts tests/integration/purchase-matcher.spec.ts` — Expected: PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(identity): manual purchase match with suggestions`.

---

### Task 7: People review page

**Files:** Create `lib/identity/review-queries.ts`, extend `lib/identity/actions.ts` (`resolveConflictAction`, `takeCidFromOtherPersonAction`, `dismissSameNameGroupAction`), writer module `lib/identity/resolve.ts`, `app/club/[clubSlug]/admin/people-review/{page,loading}.tsx`, `components/identity/{conflict-list,same-name-groups}.tsx`; modify `app/club/[clubSlug]/sessions/page.tsx` (PendingLink + open-conflict badge); test `tests/integration/identity-review.spec.ts`.

**Interfaces:**
- Produces (`review-queries.ts`): `countOpenConflicts(clubId): Promise<number>`; `listOpenConflicts(clubId)` (joined with person name/email and other person name); `listRecentOverwrites(clubId, limit = 30)`; `listSameNameGroups(clubId): Promise<Array<{ nameKey; membersHash; people: Array<{ id; fullName; email; cid; cidSource; attendanceCount; purchaseCount }> }>>` (paged person load via `fetchAllPages`; groups of ≥2 by trimmed case-folded name; excludes groups whose (name_key, members_hash) is in `person_duplicate_dismissal`; `membersHash` = sha1 of sorted ids); `listIncompleteNames(clubId)` (full name is one word).
- Produces (`resolve.ts`, no requireAdmin): `keepCurrent(clubId, conflictId, by)` → status `dismissed`; `useIncoming(clubId, conflictId, by)` — only if conflict is `flagged`+open and the incoming CID is free (else throws `That CID is now held by someone else`); sets person cid + source = incoming source, marks `resolved` with `resolved_by`/`resolved_at`; `takeCidFromHolder(clubId, conflictId, by)` — only when `other_person_id` set and incoming source outranks the holder's `cid_source` (else throws); clears holder's cid and cid_source, records an `overwritten` conflict for the holder, sets the CID on the person, resolves original; `dismissSameNameGroup(clubId, nameKey, membersHash, by)`.
- Page sections: Open CID conflicts (actions above as buttons), Recent changes (collapsed `<details>`), Same-name groups, Names that look incomplete. Sessions page shows a link "People review" with a badge when `countOpenConflicts > 0`.

- [ ] **Step 1: Write failing tests.** Open conflict shows in `listOpenConflicts` and count; `keepCurrent` dismisses and a repeat of the same disagreement (via `applyCidEvidence`) creates no new row; `useIncoming` applies when free and refuses when taken; `takeCidFromHolder` works when sso incoming vs walk_in holder (holder CID cleared, `overwritten` row for holder) and refuses when holder is equal/higher rank; same-name group of 2 appears with counts, disappears after dismissal, reappears after a third same-name person joins; one-word names listed; all writers refuse ids from another club.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement queries, writers, actions, page, components, link. Page uses `requireAdmin` redirect pattern from the purchases page and `PendingLink`/`PageSkeleton` like sibling pages.
- [ ] **Step 4:** Run the spec — Expected: PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(identity): people review page`.

---

### Task 8: Acceptance tests and docs

**Files:** Create `tests/acceptance/identity.spec.ts`; modify `docs/PROJECT_STATUS.md`.

- [ ] **Step 1: Write the acceptance spec** with the existing fixtures (`tests/acceptance/support/fixtures.ts`): (a) Ayaan end to end — seed walk_in person with wrong CID and a student purchase with the right CID (unmatched); import a CSV row for the same email with the right CID via the UI; assert CID replaced, "Recent changes" on the review page lists it, "Re-check unmatched" matches the purchase; (b) manual match from a suggestion with the CID checkbox ticked; (c) two sso people with different CIDs → flagged conflict on the review page → "Keep current" removes it and the badge; (d) same-name pair listed then dismissed; (e) walk-in form rejects `Sean` and `12345` with the exact messages and accepts `6113211`.
- [ ] **Step 2:** Run `npm run test:acceptance` — Expected: all pass (existing 17 plus new).
- [ ] **Step 3:** Add an "Identity trust and duplicates" section to `docs/PROJECT_STATUS.md` (ranking, where to review conflicts, walk-in validation, the known limitation of manual matches not being remembered, and the one-word names listed for the admin).
- [ ] **Step 4:** Run unit, integration and e2e suites — Expected: all pass (except the known flaky `person-search` tie test); `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `test(identity): acceptance suite and docs`.
