# Identity trust and duplicates — design

Date: 2026-11-14. Status: APPROVED by the user on 2026-11-14 (approach A), with walk-in input validation added at approval. Project 4 of `docs/superpowers/specs/2026-11-13-performance-and-recurring-events-design.md`.

## Intent

A purchase for a real, attending person (Ayaan Azam) stayed "unmatched" for weeks. He appears in the SSO-backed signup CSV with the right CID (06113211), but at an earlier session a walk-in form recorded a different number (his library card, 03079021) against the same person. The system never overwrites a stored CID, so the typo permanently blocked the correct one, and every student purchase carrying 06113211 failed the "student with a non-matching CID stops" rule. The admin had no way to see why, to fix it, or to match the purchase by hand (`manual_matched` exists in the schema and badge map but nothing sets it).

The user's trust ordering for identity data, in their words: the signup CSV is most trusted (email + CID come from SSO, no manual typing); the purchases XLSX next (has a CID, no email); manual walk-ins last, "with a pinch of salt" (CID can be another number, names and emails can have typos). They also want a safeguard that surfaces two people with the same name, and a "match to person" action. They chose: a higher-trust source may overwrite a lower-trust CID and the change is recorded; equal-trust disagreements are flagged, not overwritten.

## Goals

1. Every place a CID is written applies one ranking rule: SSO (CSV import, live eActivities signup sync) > purchases file > walk-in.
2. A CID overwrite never loses information: the replaced value, both sources and the time are recorded.
3. Disagreements the rule will not resolve on its own are visible to the admin in one place, with a way to resolve each.
4. An unmatched purchase can be matched to a person by hand, and when its CID is better evidence than the person's stored one, the admin can adopt it in the same step.
5. Same-name people are listed for review so duplicates are noticed.

## Non-goals

- Merging two person records (touches attendance, purchases, waivers, debt). Duplicates are shown, not merged. Own design later if they hurt.
- Changing the automatic purchase matching rules (CID, then email, then unique name; a student with a non-matching CID stops). Which person a purchase auto-matches to must not change.
- Tracking trust for name or email. Only the CID gets a source. (Walk-in name/email typos remain; the same-name list helps spot them.)
- Editing a person's fields by hand (name/email/CID) outside the flows below.
- Automatic CID changes driven by a purchase alone.

## Anti-goals

- A silent overwrite with no record of the old value.
- A purchase's CID changing a person's CID without an admin confirming the match.
- Name-only evidence changing a CID.
- A flow that makes the Ayaan case need a developer or a SQL fix.

## Approaches considered

- **A. Provenance column + one shared rule + conflict records + review page + manual match** (chosen by the user).
- B. Reuse `identity_confidence` (confirmed/provisional) as the ranking: no purchases tier, no conflict records. Rejected: loses the middle tier and the audit trail.
- C. A plus person-merge tooling. Rejected for now: large, touches debt/waiver history; revisit when duplicates are a real cost.

## Design

### Ranking and the pure rule

Sources (rank high to low): `sso` (CSV import; live eActivities sync, both carry email + CID from the SSO signup), `purchase`, `walk_in`.

`decideCidEvidence(existing: { cid: string | null; source: Source | null }, incoming: { cid: string; source: Source }): Decision` — pure, in `lib/identity/cid-rule.ts`:
- existing CID null → `set` (write CID + source).
- same CID → `confirm` (no CID change; if incoming outranks the stored source, raise the stored source to it).
- different CID, incoming outranks existing source → `overwrite` (write, record `overwritten`).
- different CID, equal rank → `flag` (do not write, record `flagged`, status open).
- different CID, incoming lower rank → `ignore` (do not write; record `ignored` once per (person, incoming CID, source) so repeats do not pile up).
- existing CID present but source null (legacy, should not remain after the migration) → treated as `sso`, the safe direction (flag rather than overwrite).
Uniqueness guard (applies to `set`/`overwrite`): CIDs are unique per club. If the incoming CID is already owned by a different person, do not write; record a `flagged` conflict with `other_person_id` set (it means two records are probably the same human). This path is the duplicate signal for CID collisions.

### Storage (one additive migration)

- `person.cid_source text null check (cid_source in ('sso','purchase','walk_in'))`. Backfill in the migration, using the evidence we already have: cid null → null; cid not null and (`identity_confidence = 'provisional'` **or** the person has attendance records but none whose origin is `signup_sync` or `csv_import`, i.e. they have only ever been seen as a walk-in or manual tick) → `walk_in`; every other person with a CID → `sso`. This labels the Ayaan-style case correctly (a person only ever seen via walk-in gets `walk_in`, so the first SSO CSV row overwrites). The residual error is a walk-in CID backfilled onto someone who is also on a CSV; that person is labelled `sso`, which errs toward flagging rather than overwriting. `identity_confidence` is not changed by any of this (no flip when a CSV matches a provisional person); `cid_source` is the truth for CID trust.
- `person_identity_conflict` (id, club_id, person_id, existing_cid, existing_source, incoming_cid, incoming_source, other_person_id null, outcome in (`overwritten`,`flagged`,`ignored`), status in (`open`,`resolved`,`dismissed`) default `open` for `flagged` else `resolved`, created_at, resolved_at null, resolved_by text null). Same-club composite FKs to `person` (matching `20261102090000_add_same_club_foreign_keys.sql`), RLS enabled + forced deny-all, added to `CLUB_SCOPED_TABLES`. This table is the audit trail for identity changes.
- `purchase.manual_matched_by text null`, `purchase.manual_matched_at timestamptz null` for the manual-match audit.
- `person_duplicate_dismissal` (id, club_id, name_key text, members_hash text, dismissed_by, dismissed_at; unique (club_id, name_key, members_hash)). A dismissal stops applying if the group's membership changes.

### Dedup, collisions and ordering (settled after the builder check)

- **No flood.** `flagged` and `ignored` conflicts are unique per (club, person, incoming CID, incoming source): the writer does insert-or-do-nothing on that key, so a CSV re-import or the next live sync does not create new rows. A dismissed conflict stays dismissed if the same disagreement recurs (the admin already said keep it); a *different* incoming CID is a new conflict. `overwritten` rows are events and are never deduplicated.
- **CID collisions are resolvable.** A conflict with `other_person_id` set (the incoming CID belongs to someone else) offers, on the review page, "Take this CID from the other person" **only when** the incoming source outranks the other person's `cid_source` (same rank rule, applied to the current holder: typical case, a throwaway walk-in duplicate holding the correct CID). It clears the holder's CID, sets it on this person, records an `overwritten` conflict for the holder, and resolves the original. When the holder is equal or higher rank the only options are "Keep current" (dismiss) until merge tooling exists. The automatic paths never take a CID from another person.
- **Bulk CSV ordering.** CIDs are unique per club by a database index (`person_club_id_cid_unique_idx`). The CSV path evaluates rows sequentially in row order against the in-memory index, updating it as it goes (a row's overwrite is visible to later rows). Batched writes must never let a unique violation abort the import: updates that vacate a CID are applied before updates that claim one, and any residual database collision downgrades that single row to a `flagged` conflict.
- **Walk-in lookup (current behaviour, unchanged).** `createWalkIn` finds an existing person by CID first, then by exact email; never by name. The rule is therefore only ever evaluated for CID- or email-matched people, which keeps the anti-goal (no name-only CID changes).
- **Known limitation.** A manual match with "use this purchase's CID" off does not make later purchases from the same buyer auto-match (the automatic rules are unchanged by design). The suggestions panel makes repeating the match a two-click action; remembering manual matches is out of scope.

### Write paths (all go through the rule)

1. CSV import (`lib/csv-import/importer.ts`, `resolvePeopleForRows`): extend the in-memory `PersonIndex` with `cidSourceById`; for a row matched by email whose row CID differs from the person's, evaluate the rule in memory; apply `set`/`overwrite`/`confirm` as batched updates and write conflict records in one bulk insert. Source `sso`. Keeps the existing bulk-performance shape (no per-row queries).
2. Live sync (`lib/attendance/sync.ts` `findOrCreatePerson`): same rule, source `sso`; new people get `cid_source` = `sso` when they have a CID.
3. Walk-in (`lib/attendance/actions.ts` `createWalkIn`): same rule, source `walk_in`; new person created `provisional` with `cid_source = 'walk_in'` when a CID was typed.
4. Manual purchase match (new, below): source `purchase`.
All four call a shared DB-writing function `applyCidEvidence(scoped, personId, cid, source)` (and a batched variant for the CSV path) in `lib/identity/apply-cid-evidence.ts`, which loads the person, calls `decideCidEvidence`, writes, and records. The decision logic exists exactly once.

### Walk-in input validation (added at approval)

Typos at the walk-in form are where bad identity data starts, so the form and the server action both validate (Zod, shared schema in `lib/identity/walk-in-schema.ts`, so client and server cannot drift):
- **CID** (optional): after trimming it must be exactly 7 or 8 digits (`^\d{7,8}$`). A 7-digit entry means the leading 0 was dropped and is normalised to 8 digits (the existing `normalizeCid`). Anything else (letters, spaces inside, other lengths, a library card number with a letter) is rejected with "CID is 8 digits, or 7 if you leave off the leading 0".
- **Full name**: required, at least two words after trimming (someone typing only a first name is rejected with "Enter first name and surname"); each word at least one letter; collapsed internal whitespace is stored.
- **Email**: required, valid (existing rule), lower-cased for matching as today.
- The server action is the authority; the form shows the same messages inline before submit.
- Not retroactive: existing single-word names are listed for the admin on the review page ("Names that look incomplete": people whose full name is one word) with the fix left to the admin; the validation applies to new walk-ins only. (At approval time two such people exist in the judo club's data besides the one already fixed by hand.)

### Manual match and suggestions (purchases page)

- `matchPurchaseToPerson(clubSlug, purchaseId, personId, options: { adoptCid: boolean })` (server action): `requireAdmin`; verify purchase and person belong to the club; only for purchases currently `unmatched`; set `person_id`, `match_status = 'manual_matched'`, `is_student` from the purchase, `manual_matched_by/at`; run `reapplyWaiversForPerson`; if `adoptCid` and the purchase has a raw CID, call `applyCidEvidence(personId, normalizedCid, 'purchase')`. A resulting `flag`/`ignore` leaves the person's CID alone, the match still stands, and the UI says the CID conflict was recorded.
- Suggestions: for an unmatched purchase, `suggestPersonsForPurchase` returns candidates by exact email (if the purchase has one) and by unique case-insensitive full name. Each candidate shows name, email, stored CID and its source, and whether adopting the purchase CID would overwrite, be flagged, or fill a blank (computed with the pure rule, display only). Search box reuses `searchPeople`.
- UI: each unmatched row in `PurchasesTable` gets a "Match…" action opening an inline panel (no dialog dependency): suggestions, search, a checkbox "Use this purchase's CID for them" (default on when the rule would `set` or `overwrite`, off otherwise), confirm button. "Re-check unmatched" is unchanged and never touches `manual_matched` rows.
- The matcher's automatic rules are untouched.

### People review page

New route `/club/[clubSlug]/admin/people-review` (with `loading.tsx` using `PageSkeleton`; link from the sessions header via `PendingLink` with a badge of open conflicts):
1. **Open CID conflicts** (`flagged`, status open): person name/email, current CID + source, incoming CID + source, other person if any. Actions: "Keep current" (status `dismissed`), "Use incoming" (allowed only if the incoming CID is free; applies it, status `resolved`, `resolved_by` = admin email). Past `overwritten` conflicts are shown in a collapsed "Recent changes" list (last 30) so overwrites are visible.
2. **Same-name groups**: people whose trimmed, case-folded full names match (computed on page load from a paged person load), each with email, CID + source, attendance count, purchase count. "Not the same person" records a dismissal keyed by group membership.
No merge action.

### Rollout

Additive migration, backfill in the same migration, applied to the dev project first (controller applies, as before). Existing behaviour is unchanged until a CSV/sync/walk-in/manual match presents a disagreeing CID.

## Testing

- Unit: exhaustive truth table for `decideCidEvidence` (every rank pair × same/different CID × null existing, legacy null source, CID owned by another person).
- Integration: each writer (CSV bulk path, sync, walk-in, manual match) against the dev DB — overwrite records a conflict; equal rank flags; lower rank is ignored once; duplicate CID owner is flagged; matching a purchase by hand sets `manual_matched`, applies waivers and writes audit columns; cross-club attempts refused; the bulk CSV path stays within its existing query budget.
- Acceptance (signed-in, throwaway club): the Ayaan scenario end to end — a walk-in with a wrong CID, a CSV row for the same email with the right CID → CID replaced, "Recent changes" shows it, the student purchase matches via "Re-check unmatched"; plus a manual match from a suggestion with "use this purchase's CID", a flagged equal-rank conflict resolved from the review page, and a same-name group listed and dismissed.

## Decisions made by me (not the user), for review

- Live eActivities sync counts as `sso` (same SSO signup data as the CSV).
- Legacy backfill rule above (errs toward flagging).
- Lower-rank disagreements are ignored but recorded once, not repeatedly.
- A CID already owned by another person is never written; it is flagged as a likely duplicate.
- Dismissals are keyed by group membership so a changed group reappears.
- Backfill uses attendance-origin evidence (walk-in-only people get `walk_in`), not just `identity_confidence`.
- Repeat flags are deduplicated per (person, incoming CID, source) and stay dismissed once dismissed.
- "Take this CID from the other person" exists only when the incoming source outranks the holder's source.
- The bulk CSV path evaluates rows in order against a live in-memory index, vacating before claiming.
- No merge tooling; no trust tracking for name/email.
- The review-page link badge counts only open CID conflicts (one cheap query); same-name groups are computed only on the review page.

## Left to the builder

Component layout of the match panel and review page, query shapes for the suggestions, naming of server actions, exact copy of messages.
