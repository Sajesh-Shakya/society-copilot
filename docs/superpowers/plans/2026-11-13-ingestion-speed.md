# Ingestion Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-uploading a sales XLSX that overlaps earlier uploads costs about as much as uploading only its new rows, and first-time bulk XLSX/CSV imports stop doing several sequential queries per row.

**Architecture:** (1) Skip rows whose row-hash already exists, with one chunked "which hashes exist" lookup. (2) Replace per-row person matching with a one-time in-memory person index and a pure matcher implementing the existing rules unchanged. (3) Insert in chunks with conflict-ignore instead of one insert per row, and only run `is_student`/waiver follow-ups for rows actually inserted. (4) Same index approach for the CSV attendance importer.

**Tech Stack:** Next.js 16 server actions, `@supabase/supabase-js` via `createClubScopedClient`, `xlsx`, Zod, Playwright (unit + integration configs).

**Spec:** `docs/superpowers/specs/2026-11-13-performance-and-recurring-events-design.md` (Project 2)

## Global Constraints

- Matching rules must not change: CID (normalised) → student-with-CID stops (no email/name fallback) → email (case-insensitive exact) → unique full name (case-insensitive exact) → unmatched.
- Row hash (`hashXlsxRow`) and its `occurrenceIndex` scheme must not change, so existing stored `source_row_id`s keep deduping.
- All DB access goes through `createClubScopedClient(clubId)`; upserts must name `club_id` in `onConflict`.
- `IngestionResult` keeps `{ inserted, duplicates, errors }`; `duplicates` now also counts rows skipped by the hash lookup.
- A bad row must still be reported per-row in `errors`, never abort the batch.
- PostgREST `.in()` filters travel in the URL: use chunks of at most 100 hashes.
- Commit steps follow repo convention and end with the attribution line from the session. Integration tests run against the real dev Supabase project and clean up after themselves (existing pattern).

## Review Focus

- A file with three identical rows (same person, product, minute) re-uploaded with four: exactly one new row is ingested.
- After `undoUpload`, re-uploading the same file ingests the rows again (the hash lookup reads the live DB, no stored cursor).
- Two people in the club share a full name: the purchase stays `unmatched`, not guessed.
- Email containing `_` (`j_smith@x.com`) must not match `j.smith@x.com` in the in-memory matcher.
- More than 1000 people in a club: the person index must page past PostgREST's default row cap.
- CSV file where two different emails carry the same CID: the second row maps to the first created person and the import does not fail on the unique CID index.

## File Structure

- Create `lib/purchase/person-index.ts` — `loadPersonIndex`, `PersonIndex`, `matchAgainstIndex`, `fetchAllPages`.
- Create `lib/purchase/existing.ts` — `findExistingSourceRowIds`.
- Modify `lib/purchase/matcher.ts` (`matchOrQueue` uses the index; `matchPersonRecord` removed), `lib/purchase/interface.ts` (`ingestPurchases`, `rematchUnmatchedPurchases`), `lib/xlsx/uploader.ts`.
- Modify `lib/csv-import/importer.ts` (shared `resolvePeopleForRows`).
- Tests: `tests/unit/person-index.spec.ts`, `tests/unit/xlsx-hash-stability.spec.ts`; additions to `tests/integration/ingest-purchases.spec.ts`, `purchase-matcher.spec.ts`, `purchase-upload.spec.ts`, `csv-import.spec.ts`.

---

### Task 1: Person index and pure matcher

**Files:**
- Create: `lib/purchase/person-index.ts`
- Test: `tests/unit/person-index.spec.ts`

**Interfaces:**
- Produces:
  - `interface PersonIndex { byCid: Map<string, string>; byEmail: Map<string, string>; byName: Map<string, string[]>; cidById: Map<string, string | null> }` — `byEmail` keys are `email.toLowerCase()`; `byName` keys are `full_name.trim().toLowerCase()`; values are person ids.
  - `buildPersonIndex(people: { id: string; cid: string | null; email: string | null; full_name: string }[]): PersonIndex` (pure).
  - `loadPersonIndex(clubId: string): Promise<PersonIndex>` — pages `person` through `fetchAllPages` and calls `buildPersonIndex`.
  - `fetchAllPages<T>(fetchPage: (from: number, to: number) => Promise<T[]>, pageSize?: number): Promise<T[]>` — repeats with `from=0,pageSize-1`, `pageSize, …` until a page returns fewer than `pageSize` rows (default 1000).
  - `matchAgainstIndex(row: RawPurchaseRow, index: PersonIndex): MatchResult` — the five rules in Global Constraints.

- [ ] **Step 1: Write failing unit tests** in `tests/unit/person-index.spec.ts` (no DB; build indexes with `buildPersonIndex`):
  - CID match → `{ personId, matchStatus: "cid_matched" }`; a CID with a lost leading zero (`"2665790"` vs stored `"02665790"`) still matches (via `normalizeCid`).
  - Student row with a CID that has no match and whose email/name do match someone → `unmatched`.
  - Non-student row, no CID match, email differs only in case → `email_matched`.
  - `j_smith@x.com` row against a person `j.smith@x.com` → `unmatched`.
  - Unique full name differing in case/whitespace → `name_matched`; two people with that name → `unmatched`.
  - `fetchAllPages` with a fake pager of 2,500 items and `pageSize` 1000 returns all 2,500 and makes exactly 3 calls.
- [ ] **Step 2: Run** `npx playwright test tests/unit/person-index.spec.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module. `loadPersonIndex` selects `id, cid, email, full_name` through `createClubScopedClient(clubId).from("person").select(...).range(from, to)` (add a stable `.order("id")`); throw on error.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(purchase): in-memory person index and pure matcher`.

### Task 2: Use the index in matching and rematching

**Files:**
- Modify: `lib/purchase/matcher.ts`, `lib/purchase/interface.ts` (`rematchUnmatchedPurchases`)
- Test: `tests/integration/purchase-matcher.spec.ts` (existing), `tests/integration/ingest-purchases.spec.ts` (existing)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `matchOrQueue(rows: RawPurchaseRow[], clubId: string): Promise<{ matched: Map<string, MatchResult>; unmatched: RawPurchaseRow[] }>` (signature unchanged; now one index load for the whole batch). `matchPersonRecord` is deleted.

- [ ] **Step 1: Migrate the existing tests** in `tests/integration/purchase-matcher.spec.ts` from `matchPersonRecord(row, clubId)` to `matchOrQueue([row], clubId)` reading `matched.get(row.externalId) ?? { matchStatus: "unmatched" }`; keep every assertion.
- [ ] **Step 2: Run** the purchase-matcher integration suite against the current code — Expected: PASS (proves the migrated tests describe current behaviour).
- [ ] **Step 3: Rewrite `matchOrQueue`** to call `loadPersonIndex(clubId)` once and `matchAgainstIndex` per row; delete `matchPersonRecord`. Rewrite `rematchUnmatchedPurchases` to load the index once and match in memory (it keeps the per-purchase `update` + `applyWaivers`).
- [ ] **Step 4: Run** `npx playwright test --config=playwright.integration.config.ts purchase-matcher ingest-purchases` — Expected: PASS.
- [ ] **Step 5: Commit** `perf(purchase): match against one in-memory person index instead of per-row queries`.

### Task 3: Skip already-ingested rows

**Files:**
- Create: `lib/purchase/existing.ts`
- Test: `tests/integration/purchase-upload.spec.ts` (add), `tests/unit/xlsx-hash-stability.spec.ts`

**Interfaces:**
- Produces: `findExistingSourceRowIds(clubId: string, source: "pluto_api" | "xlsx_upload", ids: string[]): Promise<Set<string>>` — chunks `ids` by 100, queries `purchase.source_row_id` filtered by club/source/`in`, up to 5 chunks in flight, returns the union.

- [ ] **Step 1: Write failing tests.**
  - Unit `xlsx-hash-stability.spec.ts`: build an XLSX buffer (via `xlsx` `utils.aoa_to_sheet`/`write`) with 3 identical rows plus 1 different, parse with `parseXlsxFile`, then parse a buffer with 4 identical rows plus the different one; assert the first three `externalId`s are identical across both parses and the fourth identical row has a new `externalId` (so only one is new).
  - Integration: insert 3 purchases with known `source_row_id`s for a test product, call `findExistingSourceRowIds` with those 3 plus 2 unknown ids plus a 250-id filler; assert the returned set equals exactly the 3; assert a call with `[]` returns an empty set without querying.
- [ ] **Step 2: Run** both — Expected: FAIL (module missing; hash test may pass already — keep it as a regression pin).
- [ ] **Step 3: Implement `findExistingSourceRowIds`.**
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(purchase): look up already-ingested row hashes in chunks`.

### Task 4: Chunked insert and insert-only follow-ups in `ingestPurchases`

**Files:**
- Modify: `lib/purchase/interface.ts` (`ingestPurchases`)
- Test: `tests/integration/ingest-purchases.spec.ts`

**Interfaces:**
- Consumes: `findExistingSourceRowIds` (Task 3), `matchOrQueue` (Task 2).
- Produces: `ingestPurchases(rows: RawPurchaseRow[], clubId: string, options?: { skipExistingCheck?: boolean }): Promise<IngestionResult>`. Behaviour: validate → (unless `skipExistingCheck`) drop rows whose `externalId` already exists, counting them in `duplicates` → match → resolve products (unchanged) → build records (unchanged) → insert in chunks of 200 with `.upsert(chunk, { onConflict: "club_id,source,source_row_id", ignoreDuplicates: true }).select("id, source_row_id")` → `inserted` = returned rows; `duplicates += chunk.length - returned.length`. If a chunk call errors, retry that chunk's rows one by one with the existing per-row insert so only the offending rows land in `errors`. `is_student` update and `applyWaivers` run only for rows present in the returned set (latest-per-person rule unchanged), waivers with at most 5 in flight.

- [ ] **Step 1: Write failing tests** in `ingest-purchases.spec.ts` (existing helpers/cleanup pattern):
  - `re-ingesting a mix of old and new rows` — ingest 3 rows, then ingest those 3 + 2 new: `{ inserted: 2, duplicates: 3, errors: [] }`.
  - `duplicates do not re-trigger is_student or waivers` — set `person.is_student` manually after the first ingest, re-ingest the same rows, expect the value untouched.
  - `a bad row in a chunk is isolated` — include one row with a nonexistent `productId` among 5 valid ones: `inserted: 5`, one `errors` entry naming that row's `externalId`.
  - `reingest after undoUpload inserts again` — ingest rows with an `uploadId`, call `undoUpload`, ingest the same rows: `inserted` equals the row count.
- [ ] **Step 2: Run** `npx playwright test --config=playwright.integration.config.ts ingest-purchases` — Expected: new tests FAIL, existing PASS.
- [ ] **Step 3: Restructure `ingestPurchases`** as described in Interfaces. Keep the Zod `rawPurchaseRowSchema` and error-shape unchanged.
- [ ] **Step 4: Run** the suite — Expected: all PASS, including every pre-existing idempotency/waiver test.
- [ ] **Step 5: Commit** `perf(purchase): chunked conflict-ignoring insert, follow-ups only for inserted rows`.

### Task 5: Pre-filter in `uploadXlsx` and nothing-new handling

**Files:**
- Modify: `lib/xlsx/uploader.ts`
- Test: `tests/integration/purchase-upload.spec.ts`

**Interfaces:**
- Consumes: `findExistingSourceRowIds`, `ingestPurchases(..., { skipExistingCheck: true })`.
- Produces: `uploadXlsx` result messages: new rows → `Parsed {n} rows{skippedNote}. Ingested {inserted} new purchases ({duplicates} duplicates, {errors} errors)` where `duplicates` includes the pre-filtered count; no new rows → `success: true`, `Parsed {n} rows. Nothing new — all {n} were already ingested.` and **no** `purchase_upload` row is created.

- [ ] **Step 1: Write failing tests** (call the pure pieces the existing purchase-upload tests already call, or extract a testable `planXlsxUpload(rows, clubId)` helper returning `{ newRows, alreadyIngested }` if `uploadXlsx` itself needs a signed-in session): re-running the same parsed rows yields `alreadyIngested === rows.length`, `newRows.length === 0`, and creates no `purchase_upload`; a superset yields only the extras as `newRows`, and the upload row's `row_count` equals `newRows.length`.
- [ ] **Step 2: Run** purchase-upload integration tests — Expected: FAIL.
- [ ] **Step 3: Implement.** In `uploadXlsx`, after parsing, call `findExistingSourceRowIds(clubId, "xlsx_upload", rows.map(r => r.externalId))`; if no new rows return the "nothing new" success result; else create the `purchase_upload` with `row_count = newRows.length`, call `ingestPurchases(newRows..., clubId, { skipExistingCheck: true })`, and fold the pre-filtered count into `duplicates` in the message.
- [ ] **Step 4: Run** tests — Expected: PASS.
- [ ] **Step 5: Commit** `perf(xlsx): skip already-ingested rows before creating an upload batch`.

### Task 6: CSV attendance importer without per-row lookups

**Files:**
- Modify: `lib/csv-import/importer.ts`
- Test: `tests/integration/csv-import.spec.ts`

**Interfaces:**
- Consumes: `loadPersonIndex` (Task 1).
- Produces: `resolvePeopleForRows(clubId: string, rows: AttendeeRow[]): Promise<string[]>` (person ids in `rows` order), used by both `importAttendanceCsv` and `syncAttendanceCsv` in place of `findOrCreatePersonByEmail`. Rules preserved: normalised CID match first, then email (case-insensitive); an email match with a CID on the row and none on the person backfills that CID (never overwrites a CID or email); otherwise create the person with `identity_confidence: "confirmed"`. New people are inserted in one bulk insert returning `id, email, cid`; rows in the same file sharing a CID with an earlier would-be-new row map to that same new person rather than inserting twice. `importAttendanceCsv` inserts `attendance_record`s in chunks of 500.

- [ ] **Step 1: Write failing tests** in `csv-import.spec.ts`: (a) two rows, different emails, same CID, neither in DB → one person created, both attendance rows point at it, import succeeds; (b) 300 distinct rows import fully (log elapsed ms for the human, no timing assertion); (c) existing person matched by email with CID on the row gets the CID backfilled, and an existing different CID is not overwritten; (d) existing assertions in the file stay green.
- [ ] **Step 2: Run** `npx playwright test --config=playwright.integration.config.ts csv-import` — Expected: new tests FAIL.
- [ ] **Step 3: Implement `resolvePeopleForRows`** and switch both callers; delete `findOrCreatePersonByEmail`. Backfill updates run per affected person (expected to be few).
- [ ] **Step 4: Run** the suite — Expected: PASS.
- [ ] **Step 5: Commit** `perf(csv-import): resolve people from one index, bulk-create the missing ones`.

### Task 7: Upload limits and wrap-up

**Files:** Possibly modify `next.config.ts`, `app/club/[clubSlug]/admin/purchases/page.tsx`; modify `docs/PROJECT_STATUS.md`.

- [ ] **Step 1: Check limits.** Generate a throwaway 5,000-row XLSX in the scratchpad directory with `xlsx`; note its size. Next.js server actions default to a 1 MB body limit (read `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`). If the file exceeds 1 MB, set `experimental.serverActions.bodySizeLimit` in `next.config.ts` to a value above the realistic maximum (e.g. `"5mb"`).
- [ ] **Step 2: Duration.** If a first-time 5,000-row upload could approach the Vercel function default timeout, add `export const maxDuration = 60;` to the purchases page (server actions inherit the page's value). Skip this step if the plan's integration timing for 300 rows (Task 6 Step 1b) suggests ample headroom, and say which you did.
- [ ] **Step 3: Run all suites:** `npm run test:unit`, `npm run test:integration`, `npm run lint`, `npm run build` — Expected: all pass.
- [ ] **Step 4: Verify the headline claim.** Using the user's real previous export (ask for it, do not fabricate), re-upload it through the running app on the preview deploy and confirm the message reports "already ingested" counts and returns quickly; record before/after in `docs/PROJECT_STATUS.md`.
- [ ] **Step 5: Commit** `docs: record ingestion-speed results`.
