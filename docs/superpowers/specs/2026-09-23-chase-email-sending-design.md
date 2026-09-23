# Chase Email Real Sending — Design

Status: approved (2026-09-23)

## Context

`generateChaseEmails()` drafts chase emails and `sendChaseEmail()` /
`processAutoSends()` (`lib/chase/send.ts`) already implement the
approval/debt-recheck state machine, but the "send" step only flips
`chase_email.status` to `'sent'` — no email is ever transmitted. This is the
gap this design closes.

It follows directly from the auth-email deliverability saga earlier this
project (magic link → OTP code → abandoned in favour of password auth,
because Gmail-relayed mail to Imperial/Microsoft 365 inboxes was
unreliable). Chase emails are bulk, recurring, financial-content reminders —
a pattern more likely to be spam-filtered than a one-off sign-in code — so
this design deliberately avoids repeating that mistake rather than
root-causing it further.

## Decisions already made (by the user, before this doc)

- **Sending identity**: a new domain claimed via the GitHub Student
  Developer Pack (Namecheap), with a **subdomain** (e.g. `mail.<domain>`)
  used for sending — not the bare root domain, which may be used for
  something else later.
- **Provider**: [Resend](https://resend.com), verified against that
  subdomain.
- **From/reply-to**: `from` is the verified subdomain sender address;
  `reply-to` is hardcoded to `judo@ic.ac.uk` so replies land in the
  society's real inbox regardless of sending provider.
- **Credential isolation**: `RESEND_API_KEY` / `CHASE_FROM_EMAIL` are fully
  separate from `GMAIL_USER` / `GMAIL_APP_PASSWORD` (the now-dead auth-email
  SMTP credentials). A deliverability problem with one sending identity must
  never affect the other. The Gmail credentials should be removed from
  `.env.local` and Vercel once confirmed unused elsewhere.
- **Failure handling**: add a `failed` status to `chase_email`. On failure,
  the row stays visibly `failed` with an error message — **no automatic
  retry loop**. This matches the project's human-approval/audit-logging
  principle (AGENTS.md): a failure needs a human to see why before it's
  resent, not a silent cron retrying the same failure indefinitely. Retry is
  manual: an admin re-approves the draft, which becomes sendable again.
- **Traceability**: store the provider's message id (`provider_message_id`)
  on the `chase_email` row once sent, given the real time already spent
  debugging "did this email actually send" during the OTP saga.
- **Failure visibility**: a failed send must be visible without an admin
  having to proactively open the chase inbox and notice a status value in a
  list. Since sending happens via an unattended cron job, a failure nobody
  notices for weeks defeats the point of tracking it.
- **Atomic claim before sending**: a row must be claimed (status flipped
  from `approved` to an in-flight state) via a conditional update *before*
  the Resend call, not just checked-then-updated-after. This closes the
  race where the cron and a manual "Send" click both read `status =
  'approved'`, both pass the exempt/debt checks, and both call Resend
  before either has recorded the outcome — the same double-send risk class
  already guarded against for attendance ticking (`onConflict` upserts).
- **Idempotency key on the Resend call**: pass `chase_email.id` as Resend's
  idempotency key on every send attempt for that row. This is a second
  layer of protection: if our own status write fails or times out *after*
  Resend has already accepted the send, a later manual retry (same row,
  same key) is deduplicated by Resend itself rather than risking a real
  duplicate email.
- **Scoped API key**: create `RESEND_API_KEY` with sending-only
  permissions in Resend's dashboard (not a full-access key), if that
  scoping option is available.

## Goals

- Real email delivery for approved chase emails, via Resend.
- Failures are recorded distinctly from successes, with enough detail to
  debug without re-reading provider dashboards from scratch.
- Failures are surfaced proactively on the page admins already land on.
- Auth-email and chase-email sending identities are fully decoupled.
- A batch of sends (e.g. the cron's `processAutoSends()` loop) doesn't
  trip Resend's rate limits.

## Non-goals

- No automatic retry of failed sends (explicitly rejected above).
- No new admin UI beyond a count/badge — the existing chase inbox list
  already becomes the place to see *why* a send failed once this ships.
- No change to chase-email cadence, approval workflow, or content
  templating (`generateChaseEmails()`, `buildChaseEmailContent()`).
- No support for providers other than Resend (the `EmailChannelAdapter`
  interface exists so this isn't a rewrite later, not because a second
  provider is being built now).

## Architecture

Per `core/INTEGRATIONS.md`'s ports-and-adapters strategy, sending is wrapped
behind a channel-adapter interface so `lib/chase/send.ts` (workflow core)
never talks to Resend's SDK directly:

```ts
// lib/email/types.ts
export interface EmailChannelAdapter {
  send(input: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string; // chase_email.id -- see "Idempotency key" below
  }): Promise<{ providerMessageId: string }>;
  // Rejects (throws) on failure; the caller is responsible for turning
  // that into a `failed` chase_email row, not the adapter.
}
```

```ts
// lib/email/resend-adapter.ts
export class ResendEmailAdapter implements EmailChannelAdapter {
  async send({ to, subject, body, idempotencyKey }) {
    // Uses RESEND_API_KEY / CHASE_FROM_EMAIL from env.
    // reply_to is always "judo@ic.ac.uk" -- not caller-configurable, since
    // there's currently exactly one reply destination for this product.
    // idempotencyKey is passed as Resend's Idempotency-Key header.
  }
}
```

`lib/chase/send.ts` constructs a `ResendEmailAdapter` (module-level, same
pattern as `createAdminClient()`) and calls it after atomically claiming
the row (see "Atomic claim" below), passing `chaseEmailId` as
`idempotencyKey`.

### Idempotency key

Resend's send endpoint accepts an `Idempotency-Key` header: a repeated
request with the same key returns the original result instead of sending
again. Using `chase_email.id` as that key means every send *attempt* for a
given row -- the first try and any later manual retry after a `failed`
status -- shares one key. If Resend already accepted an earlier attempt but
our status write never landed (timeout, crash), a retry can't produce a
second real email: Resend recognizes the key and returns the original
`providerMessageId`.

## Data flow

```
processAutoSends() / "Send" button (ApprovalActions)
  -> sendChaseEmail(chaseEmailId)
       -> [existing] fetch row, check status === 'approved'
       -> [existing] check person.is_exempt -> cancel if true
       -> [existing] getOutstandingDebt() -> cancel if cleared
       -> [NEW] atomic claim: UPDATE chase_email SET status = 'sending'
            WHERE id = :id AND status = 'approved' RETURNING id
            -> 0 rows affected: another caller already claimed/actioned
               this row -> return { sent: false, reason: 'stale' }
       -> [NEW] fetch person.email, adapter.send({ to, subject, body,
            idempotencyKey: chaseEmailId })
            -> success: update row { status: 'sent', sent_at, provider_message_id }
            -> failure: update row { status: 'failed', note: <error message> }
       -> return { sent: boolean, reason?: string }
```

The pre-send exempt/debt-recheck ordering is unchanged — those checks still
run, and still cancel, *before* any Resend call is made, so an
already-cleared debt never triggers a real send attempt. The atomic claim
sits immediately after those checks and immediately before the Resend
call, so only one caller can ever proceed past it for a given row.

## Schema changes

One migration, `alter_chase_email_add_failed_status_and_provider_id`:

```sql
alter table chase_email drop constraint chase_email_status_check;
alter table chase_email add constraint chase_email_status_check
  check (status in ('draft','pending_approval','approved','sending','sent','cancelled','failed'));

alter table chase_email add column provider_message_id text;
```

`sending` is the atomic-claim state from "Data flow" above: a row sits
there only for the duration of one `sendChaseEmail()` call, and always
exits it to either `sent` or `failed`. It should never be visible as a
steady-state value in normal operation; if a row is ever found stuck at
`sending` (e.g. the process crashed mid-call), that's a bug to
investigate, not an expected state the UI needs to handle gracefully.

`note` (already an existing column, used today for cancellation reasons) is
reused for the Resend error message on failure — no new column needed for
that.

## Error handling

- **Claim fails** (0 rows affected by the `approved -> sending` conditional
  update): another caller already claimed this row. Returns
  `{ sent: false, reason: 'stale' }` — the same reason already used for the
  pre-existing end-of-function stale check, since it's the same class of
  "someone else got here first" outcome.
- **Adapter throws** (network error, Resend 4xx/5xx, invalid `to` address,
  etc.): caught in `sendChaseEmail()`, row updated to
  `{ status: 'failed', note: <error.message, truncated> }`. The function
  returns `{ sent: false, reason: 'send_failed' }` rather than re-throwing,
  so `processAutoSends()`'s loop continues to the next row instead of
  aborting the whole cron run on one bad send.
- **`processAutoSends()`**: already loops per-row and tolerates any one
  `sendChaseEmail` outcome; no structural change needed there beyond the new
  `failed` outcome flowing through the same `sent++`/`cancelled++` counters
  (a `failed` result increments neither — the summary return type gains a
  `failed: number` field).
- **Manual "Send" button** (`ApprovalActions` / `lib/chase/actions.ts`):
  the existing toast-on-failure path already handles a non-`sent` result;
  it gains a `"Send failed -- see chase inbox for details"` message for the
  new `reason: 'send_failed'` case.

## Rate limiting

`processAutoSends()`'s `for` loop currently calls `sendChaseEmail` with no
delay between iterations. Add a small fixed delay (e.g. 250ms) between
sends in that loop only — cheap insurance against Resend's per-second limit
for a mailing pattern that's inherently low-volume (a university society's
debtor list), not a general throttling system.

**Not blocking, flagged for later**: at current scale (tens of debtors) a
250ms/row delay inside one Vercel function invocation is trivial. If the
debtor list grows substantially, a serial delay loop inside a single cron
invocation could eventually approach Vercel's function execution timeout.
Not a concern today — leave an inline comment noting it so it's not
forgotten if batch size changes materially.

## Failure visibility

`/app/sessions/page.tsx` is the page every admin lands on first (root `/`
already redirects there). Its header already links to `/admin/unpaid`,
`/admin/chase-inbox`, `/admin/purchases`. Add a failed-send count next to
the "Chase inbox" link — a small destructive-variant `Badge` showing the
count of `chase_email` rows with `status = 'failed'`, rendered only when
count > 0. This requires no new page: it's one extra count query in the
existing server component, surfaced where admins already look.

The chase inbox itself (`/admin/chase-inbox`) currently only queries
`status in ('pending_approval', 'approved')`. It gains `'failed'` to that
list so a failed row is visible there with its `note` (the error) shown the
same way rejection notes already render, and its `ApprovalActions` shows an
"Approve" button (re-approving moves it back to `approved`, from which the
existing "Send" flow can retry it) instead of "Send"/"Reject".

## Config

New env vars (`.env.local`, and Vercel project env for production):

- `RESEND_API_KEY` — create this key scoped to sending-only permissions in
  Resend's dashboard, if that option is available, rather than a
  full-access key.
- `CHASE_FROM_EMAIL` — the verified subdomain sender address (e.g.
  `payments@mail.<domain>`)

`GMAIL_USER` / `GMAIL_APP_PASSWORD` are no longer referenced by any code
path after this change (auth is password-based; chase emails use Resend) —
remove them from `.env.local` and Vercel once confirmed unused.

## Testing

- Unit test `ResendEmailAdapter` is skipped in favor of testing
  `sendChaseEmail()`'s branching against a fake `EmailChannelAdapter`
  (constructor-injected or module-mockable) that can be made to resolve or
  reject, covering: success path (status/provider_message_id set),
  adapter-throws path (status becomes `failed`, note set), confirming the
  existing exempt/debt-cleared cancellation paths still short-circuit
  before the adapter is ever called, the claim being called with
  `idempotencyKey: chaseEmailId`, and a pre-claimed row (simulated by
  pre-setting status to something other than `approved` between the debt
  check and the claim update) returning `{ sent: false, reason: 'stale' }`
  without calling the adapter.
- `processAutoSends()`: extend existing tests (if any) to cover a mixed
  batch (one success, one failure, one already-cancelled) and assert the
  returned counts.
- No live Resend calls in automated tests — the domain won't be verified
  immediately, and tests shouldn't depend on external network/deliverability
  anyway.

## Rollout

1. Migration (add `failed` status + `provider_message_id`).
2. Implement adapter + `lib/chase/send.ts` changes + failed-badge + chase
   inbox `failed` row rendering.
3. Ship with `RESEND_API_KEY` unset in production until the domain is
   verified — `ResendEmailAdapter` should fail loudly (not silently
   no-op) if the key is missing, so a misconfiguration surfaces as a
   `failed` row rather than a silent black hole.
4. Once DNS/domain verification is done, set `RESEND_API_KEY` and
   `CHASE_FROM_EMAIL` in Vercel and remove the Gmail auth-email env vars.
