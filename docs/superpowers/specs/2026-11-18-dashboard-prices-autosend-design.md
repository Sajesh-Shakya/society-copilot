# Metrics dashboard, product prices, per-person auto-send: design

Date: 2026-11-18. Status: implemented (2026-11-20); single-session product split script written but not yet applied. Supersedes the open questions in `docs/superpowers/handoffs/2026-11-16-dashboard-products-autosend.md`.

## Intent
Club admins/committee want to see whether the club is on track (attendance and money) without opening SQL, to manage product prices themselves, and to stop approving every payment-reminder email by hand.

## Goals
1. A per-club dashboard answering: are we hitting our signups-per-session target, how much money have we taken, how much is owed.
2. Admin-editable products and prices (add, rename, set price, retire), per club.
3. Per-person standing approval for payment chasing: approve a person once, and every later reminder to them (including future debt cycles) goes out without another approval. Exempt people never get one.

## Non-goals
- Attendee search page / info card (parked by the user until there is a use case).
- Revenue forecasting, charts beyond simple trend bars, exports, new-vs-returning split (candidate for later).
- Changing how debt is counted (still derived from `outstanding_attendance`).
- Per-club email sender identity.

## Anti-goals (failure even if it "works")
- A mass email going to people who did not get individual approval, or to exempt people.
- Past revenue changing when a price is edited.
- Totals that silently truncate at PostgREST's 1000-row cap.

## Decisions made by the user
- Targets: average **20 signups per session ideal, 15 minimum**.
- Old purchases keep the price they were bought at when a price changes.
- Auto-send: "one approval per person and you don't have to do it again".
- One extra committee metric, chosen by me and accepted: **money owed** (total, people, age).
- Approach A: compute totals in SQL (views/functions), page only renders.

## Approaches considered
- **A (chosen):** SQL views/RPCs return aggregates per club; page renders them. Fast, no row-cap problem, testable in integration tests.
- B: fetch rows and sum in TypeScript. Simpler, breaks past 1000 rows.
- C: stored daily snapshot table. Extra moving parts, stale numbers; unjustified at this scale.

## Findings that shape the design
- No money exists in the schema today: `product` has no price; debt is a count of unpaid sessions (`outstanding_attendance`, `active_debt_cycle.debt_count`).
- Chasing already auto-sends repeat reminders (`sequence_number > 1`) behind env `CHASE_AUTO_SEND_REPEATS`; the first email of each debt cycle always needs manual approval (DC-3). So "approve once per person" means: remove the per-cycle first-email gate for people who have a standing approval.
- `AGENTS.md` says human approval before any send. The user has now asked for per-person standing approval; this design records it as an amendment (to be added to AGENTS.md in the implementation).

## Design

### 1. Prices and products
- `product.price_pence integer null check (>= 0)`; `product.active boolean not null default true` (retire instead of delete; purchases reference products).
- `purchase.price_pence integer null`: snapshot copied from the product at ingest time (CSV/XLSX upload and Pluto path). Editing a product price never touches existing purchases.
- Backfill: existing purchases have null price. Admin action "Apply current price to unpriced purchases of this product" fills only nulls. Revenue treats null as 0 and the dashboard shows "N purchases have no price" with a link.
- **Member and non-member single sessions are separate products** (user, 2026-11-18): GBP 5 member, GBP 8 non-member. Production data check: uploads `Product_Sales_ID_2922*` (member, more rows) and `Product_Sales_ID_2880*` (non-member, about 6 rows total) were both ingested under the one product "Single Session Pass", so the app cannot tell them apart today. Other judo products seen: "10-Session Batch Pass" (file 3034), "All 3 Terms Pass" (file 2920). Fix: split into "Single Session Pass (Member)" and "Single Session Pass (Non-member)"; re-point the existing 2880 uploads' purchases to the non-member product (one-off, shown to the user before running). Optional (my proposal): store the eActivities sales id on the product (`external_sales_id`) so the uploader pre-selects the product from the filename `Product_Sales_ID_<id>`; removes the wrong-product-upload mistake that caused this.
- **Money owed is shown in sessions, with a pound range** (user, 2026-11-18): the app does not decide whether an owing person is a member. Only members can buy member-price products, so that is enforced at purchase level; anyone who owes just pays whichever applies (or joins). Dashboard: "N unpaid sessions across P people, worth GBP A to GBP B", where A = N x cheapest active single-session product price and B = N x dearest (derived from active `session_pass` products with `covers_sessions = 1`; no member/non-member designation needed). If no priced single-session product exists, show counts only. Chase emails keep saying how many sessions are owed (no amounts added).
- New admin page `admin/products`: list products with price, kind, covers; add product form; edit price/name/active. Validation with Zod; errors returned as `{ error }`. Club-scoped, requireAdmin.

### 2. Dashboard (`admin/dashboard`, linked from sessions page)
All numbers from SQL views/functions that take a club id and a date range (default: current term/last 8 weeks; selectable).
- **Signups per session:** per session: signups (attendance_record rows), attended count. Average over the range as headline. Status bands from club settings `signup_target` (default 20) and `signup_min` (default 15): green >= target, amber >= min, red < min. Simple bar list of recent sessions. Cancelled sessions excluded.
- **Revenue:** sum of `purchase.price_pence` in range, split by product; count of unpriced purchases.
- **Money owed:** total (debt_count x session fee), number of people owing, age buckets (0-14, 15-30, 31+ days from `debt_cycle_started_at`). Exempt people excluded (already by `active_debt_cycle`).
- Targets (`signup_target`, `signup_min`) stored on `club`, editable on the dashboard by admins.

### 3. Per-person standing approval
- `person.chase_auto_approved_at timestamptz null`, `chase_auto_approved_by uuid null` (club-scoped, composite same-club FK style as existing identity columns).
- Granting: in the chase inbox, approving a first-in-cycle email offers "Approve and don't ask again for this person" (sets the column). Revoke from the same screen / people list.
- Generator: when creating a first-in-cycle email for a person with `chase_auto_approved_at` set and `is_exempt = false`, create it pre-approved so `processAutoSends` sends it. Sequence > 1 behaviour unchanged.
- Gates at send time (re-checked, not only at generation): person not exempt, person still has debt, standing approval still set, club pause switch off. A revoke or exempt mark between generation and send cancels the send.
- `club.chase_auto_send_paused boolean not null default false`: one switch to stop all auto-sends for the club. Per-run cap: `CHASE_AUTO_SEND_MAX_PER_RUN` (default 50) so a bug cannot blast everyone.
- `CHASE_AUTO_SEND_REPEATS` env flag stays as the global master switch; standing approval only takes effect when it is "true".
- Audit: every auto-sent email records that it was sent under standing approval (existing `chase_email` approved_by/approved_at set to the approving admin and the time of the standing approval; add `auto_approved boolean`).

## Constraints
Next.js 16 conventions (read `node_modules/next/dist/docs/`), club-scoped client for all queries, new tables/columns follow composite-FK + RLS deny-all pattern, additive migrations applied before deploy, tests use throwaway clubs only, no real-person data in fixtures.

## Left to the builder
View/RPC shapes, chart styling (plain bars acceptable), date-range control details, exact copy.

## My calls (please check)
- Revenue counts passes only; per-session money is shown as "owed", not "taken", since the app does not record pay-per-session payments (a payment shows up as a purchase/pass).
- Money owed is a range (cheapest to dearest single-session price), not a per-person figure.
- Cap of 50 sends per run and a pause switch are additions you did not ask for.
- Retire products instead of deleting.
- Default range 8 weeks.

## Open for the user
- Filename-to-product auto-select (`external_sales_id`): included as a small optional task unless you say drop it.
