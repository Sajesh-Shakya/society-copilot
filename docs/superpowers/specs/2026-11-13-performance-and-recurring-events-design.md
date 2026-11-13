# Performance + recurring events — design

Date: 2026-11-13. Status: approved by the user on 2026-11-13.

Three independent projects, built in this order. Each gets its own plan.

1. Navigation speed
2. Ingestion speed (XLSX purchases, CSV attendance)
3. Event end time + recurring events
4. (Later, own design) Identity trust and duplicates: CID provenance ranking
   (CSV/SSO > XLSX > walk-in/manual; higher rank may overwrite a lower-rank CID, equal-rank
   disagreement is flagged), recorded conflicts instead of silently ignored mismatches,
   a duplicate-name/CID/email review list, and a manual "match purchase to person" action
   (`manual_matched` exists in the schema and badge map but nothing sets it). Motivated by
   a walk-in typo CID blocking an SSO-backed CID and leaving a purchase unmatched.

## Intent

The admin feels the deployed app is slow in two places: clicking between pages
(even ones already visited), and uploading XLSX/CSV files. Re-uploading a full
sales export for 1–2 new rows takes as long as the first upload. They also
want a recurring-event feature, and want the event happening "now" to be
instantly reachable.

## Goals / non-goals / anti-goals

Goals: clicks respond visibly at once; page data arrives sooner; re-uploading an
overlapping XLSX costs roughly the same as uploading only its new rows; recurring
weekly events with an empty roster (CSV applies to the first occurrence only) and
"delete this and all later".

Non-goals: caching business data (all pages stay `force-dynamic`, data stays fresh);
timestamp cursors; recurrence patterns other than weekly; editing a series in place;
changing the matching rules (CID → email → name, student CID-only rule).

Anti-goals: a faster path that can ingest a row twice, skip a row that should be
ingested, or change which person a purchase matches. Admin authorization must still be
re-checked against the DB on every request (revoking an admin takes effect immediately).

## Approaches considered

- Nav: (a) cache page output — rejected, fights fresh attendance/debt data;
  (b) cut the server round trips + add `loading.tsx` skeletons + targeted full prefetch
  — chosen; (c) client-side stack/history cache — rejected, Next's client cache
  (`staleTimes`) already is that and only helps within its TTL.
- Dedup: (a) timestamp cursor — rejected: minute-precision dates force `>=` plus
  hash dedupe anyway, and it breaks after `undoUpload`/backdated rows;
  (b) filter by existing row hashes — chosen: exact, one query.

## Project 1 — Navigation speed

Findings: middleware does `auth.getUser()` (network call to Supabase Auth); the page then
calls `requireAdmin`, which does `auth.getUser()` again plus two sequential queries
(`club` by slug, then `admin` by email+club). Four sequential hops before the page's own
queries start. No `loading.tsx` exists, so dynamic routes aren't prefetched at all.

Changes:
- Middleware and `requireAdmin` use `auth.getClaims()` instead of `getUser()`. The
  project signs JWTs with ES256 (checked: JWKS endpoint serves a key), so verification is
  local, no network. Trade-off: a signed-out/disabled auth user stays valid until JWT
  expiry; admin membership is still checked live in the DB, which is the part that matters.
- `requireAdmin`: one query (admin joined to club by slug + email) instead of two, same
  identical "Not authorized for this club." message for unknown slug and non-admin. Wrap
  in React `cache()` so one request pays once even if called from several components.
- `loading.tsx` + skeleton for each route under `/club/[clubSlug]`: sessions list,
  session detail, purchases, unpaid, chase-inbox, new, import. Add the shadcn `skeleton`
  primitive.
- Pending feedback: links/buttons that navigate show a pending state (`useLinkStatus`);
  upload and import buttons show a spinner/disabled state (check what exists first).
- Prefetch: on the sessions list, the session whose window contains "now" gets
  `prefetch={true}` (full page + data, cached 5 min by default). Window = `starts_at − 1h`
  to `ends_at + 1h`; until Project 3 adds `ends_at`, use `starts_at + 2h` as the assumed
  end. The attendance screen already layers Realtime on its initial render, so a few
  minutes of staleness there is harmless.
- First task of the plan: confirm the Vercel function region and the Supabase region are
  the same (vercel.json sets no region). A mismatch multiplies every hop above and is fixed
  with a one-line `regions` setting.
- Measure before/after (server timing around auth + page) so the claim is verified, not assumed.

## Project 2 — Ingestion speed

Findings: both importers loop one row at a time with 3–6 queries per row (person match
by CID, email, name; insert; person update; waiver RPC), including rows already ingested,
which are only rejected at the insert (23505).

XLSX purchases (`lib/xlsx/*`, `lib/purchase/interface.ts`, `matcher.ts`):
1. Parse as today (cheap, no DB).
2. One query per ≤500-hash chunk: which `source_row_id`s already exist for this club and
   `source='xlsx_upload'`. Drop those rows; report them as "already ingested".
3. For the remaining rows, load the club's person index once (id, cid, email, full_name,
   paginated) and match in memory with a pure function implementing exactly the existing
   rules. Keep the DB-backed `matchPersonRecord` only if other callers still use it.
4. Bulk insert in chunks with conflict-ignore on the existing unique key, so a race with
   a concurrent upload still can't double-insert. Only actually-inserted rows get the
   `is_student` update and waiver RPC (bounded concurrency).
5. Result message gains the already-ingested count; existing fields keep meaning.

CSV attendance (`lib/csv-import/importer.ts`): same idea. Load the person index once,
resolve CID → email in memory (keeping the CID backfill and the "never overwrite"
rules), bulk-insert missing people, then the existing bulk attendance upsert.

Checks for the plan: Next server-action body-size limit (default 1 MB) and Vercel function
duration against a realistic large file; raise or stream if needed.

## Project 3 — Event end time + recurring events

Schema (new migration):
- `session.ends_at timestamptz null`. Null (existing rows) is treated as `starts_at + 2h`.
- `session_series` (id, club_id, title, created_at) and `session.series_id uuid null`
  referencing it (same-club FK, matching the repo's multi-tenancy pattern).

Create flows: the existing new/CSV-import session forms gain an end time. A new
"recurring" option takes: title, first start, end time, repeat weekly until a date, and an
optional signup CSV. Occurrences are materialised as ordinary `session` rows (so every
existing screen works unchanged). The CSV, if given, populates the first occurrence only;
the rest start with empty rosters. Occurrence times are computed in Europe/London local
time so a 19:00 session stays 19:00 across the clock change (not +7×24h in UTC).

Delete: "Delete this and all later events" on a series member, with a preview/confirmation
("12 events will be deleted, 2 kept because they have attendance"). Applies to
occurrences of that series starting at or after the chosen one. An occurrence is deleted
if it has not happened yet (`starts_at` in the future), or if it has no attended records.
Any occurrence with an `attended = true` record is kept and listed, because deleting it
would erase attendance and debt history. The user said future events may be deleted without
extra checks; I keep one cheap guard (a single count of attended records across the target
set) because an event can be ticked ahead of time, and that costs one query. Non-series
sessions are unaffected.

## Decisions made by me (not the user), for review

- Weekly only; ends at a chosen date.
- Null `ends_at` → `starts_at + 2h`.
- Sessions with recorded attendance survive a series delete.
- Person index is loaded in memory per ingest rather than adding batch SQL functions.
- `getClaims` over `getUser`, with the revocation trade-off above.

## Left to the builder

Skeleton visuals, exact pending-state components, chunk sizes, whether the waiver RPC
needs a batch variant (only if profiling the first-ever bulk upload shows it matters).
