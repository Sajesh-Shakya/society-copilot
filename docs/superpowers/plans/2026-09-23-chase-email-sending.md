# Real Chase-Email Sending (Resend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sendChaseEmail()` actually send email via Resend, with atomic claim + idempotency to prevent double-sends, a `failed` status with manual (never automatic) retry, and failure visibility on the main admin page.

**Architecture:** A thin `EmailChannelAdapter` interface (`lib/email/types.ts`) wraps Resend behind a `fetch`-based adapter (`lib/email/resend-adapter.ts`), following this repo's existing thin-fetch-wrapper convention (see `lib/eactivities/client.ts`) rather than adding an SDK dependency. `lib/chase/send.ts`'s `sendChaseEmail()` gets a new atomic-claim step (`approved -> sending`, a conditional update) between its existing exempt/debt checks and the adapter call, so concurrent callers can't both send. The adapter call carries `chase_email.id` as Resend's idempotency key as a second guard. On adapter failure the row becomes `failed` (never auto-retried); admins retry by re-approving from the chase inbox, which now also surfaces `failed` rows and a failed-count badge on `/sessions`.

**Tech Stack:** Next.js Server Actions, Supabase (`service_role` admin client), Resend REST API via `fetch` (no SDK), Playwright test runner for both unit and integration tests (this repo's existing convention — see `tests/unit/` and `tests/integration/`).

**Spec:** `docs/superpowers/specs/2026-09-23-chase-email-sending-design.md`

## Global Constraints

- No automatic retry of a `failed` chase email, ever — retry is a human re-approving it from the chase inbox (spec: "Failure handling").
- `reply_to` on every sent email is hardcoded to `judo@ic.ac.uk` — not caller-configurable (spec: "Decisions already made").
- Resend's idempotency key on every send attempt is `chase_email.id` itself — the same row's retries share one key (spec: "Idempotency key on the Resend call").
- The atomic claim (`approved -> sending`) happens *after* the existing exempt/debt-cleared checks and *before* any Resend call (spec: "Data flow").
- `sending` is a transient state only — never a steady-state value a human is meant to see (spec: "Schema changes").
- The 250ms delay between sends applies only inside `processAutoSends()`'s loop, not the single-row "Send" button path (spec: "Rate limiting").
- `RESEND_API_KEY` should be created scoped to sending-only permissions in Resend's dashboard if that option exists — this is an operational step for whoever creates the key, not something code can enforce (spec: "Scoped API key").
- Gmail auth-email env vars (`GMAIL_USER`, `GMAIL_APP_PASSWORD`) must never be read by any code this plan adds — full credential isolation from chase-email sending (spec: "Credential isolation").

---

## Task 1: Migration — `failed`/`sending` statuses and `provider_message_id`

**Files:**
- Create: `supabase/migrations/20260923140000_add_chase_email_failed_status_and_provider_id.sql`

**Interfaces:**
- Produces: `chase_email.status` now additionally accepts `'sending'` and `'failed'`. `chase_email.provider_message_id` (nullable `text`) exists for later tasks to write to.

- [ ] **Step 1: Write the migration file**

```sql
-- Migration: chase_email 'sending'/'failed' statuses; provider_message_id
-- docs/superpowers/specs/2026-09-23-chase-email-sending-design.md
--
-- 'sending' is the atomic-claim state a row occupies only for the
-- duration of one sendChaseEmail() call -- it always exits to 'sent' or
-- 'failed'. A row found stuck at 'sending' outside that window is a bug,
-- not a state the UI needs to handle gracefully.
--
-- 'failed' is a terminal state with no automatic retry: an admin must
-- re-approve the row from the chase inbox to try again (see the
-- companion change to lib/chase/approval-writer.ts's approveChaseEmail).

alter table public.chase_email drop constraint chase_email_status_check;
alter table public.chase_email add constraint chase_email_status_check
  check (status in ('draft','pending_approval','approved','sending','sent','cancelled','failed'));

alter table public.chase_email add column provider_message_id text;

comment on column public.chase_email.provider_message_id is
  'Resend''s message id for a sent email. Set only when status = sent. Used for support/debug traceability.';
```

- [ ] **Step 2: Apply the migration**

Apply it to the Supabase project with the `mcp__supabase__apply_migration` MCP tool: pass `name: "add_chase_email_failed_status_and_provider_id"` and the SQL body above as `query`. This is the same mechanism used for every other file already in `supabase/migrations/` in this repo (they were all applied this way, not via a local dev stack — this project has no `supabase/schemas/` or local Supabase CLI stack).

- [ ] **Step 3: Verify**

Run a verification query with the `mcp__supabase__execute_sql` tool:

```sql
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'chase_email' and column_name = 'provider_message_id';
```

Expected: one row, `data_type = 'text'`.

Then:

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.chase_email'::regclass and contype = 'c';
```

Expected: `chase_email_status_check` includes `'sending'` and `'failed'` in its definition.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260923140000_add_chase_email_failed_status_and_provider_id.sql
git commit -m "feat(chase): add sending/failed statuses and provider_message_id to chase_email"
```

---

## Task 2: Email channel adapter (Resend, via fetch)

**Files:**
- Create: `lib/email/types.ts`
- Create: `lib/email/resend-adapter.ts`
- Test: `tests/unit/resend-adapter.spec.ts`

**Interfaces:**
- Consumes: `process.env.RESEND_API_KEY`, `process.env.CHASE_FROM_EMAIL`, global `fetch`.
- Produces:
  - `interface EmailChannelAdapter { send(input: { to: string; subject: string; body: string; idempotencyKey: string }): Promise<{ providerMessageId: string }> }` from `lib/email/types.ts`.
  - `class ResendEmailAdapter implements EmailChannelAdapter` from `lib/email/resend-adapter.ts`, plus a ready-to-use singleton `export const resendEmailAdapter = new ResendEmailAdapter();`.
  - `class ResendNotConfiguredError extends Error` and `class ResendApiError extends Error`, both exported from `lib/email/resend-adapter.ts`, thrown by `.send()`.

- [ ] **Step 1: Write the interface**

Create `lib/email/types.ts`:

```ts
// The internal port every outbound-email caller depends on -- see
// core/INTEGRATIONS.md's "Channel adapters" layer. Never import a specific
// provider (Resend, etc.) outside of its own adapter file.
export interface EmailChannelAdapter {
  send(input: {
    to: string;
    subject: string;
    body: string;
    // Passed straight through to the provider's idempotency mechanism.
    // Callers should pass a value that's stable across retries of the
    // same logical send (e.g. a chase_email row's id) so a retry after a
    // failed status-write can't produce a real duplicate email.
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}
```

- [ ] **Step 2: Write the failing unit test**

Create `tests/unit/resend-adapter.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import {
  ResendEmailAdapter,
  ResendApiError,
  ResendNotConfiguredError,
} from "@/lib/email/resend-adapter";

test.describe("ResendEmailAdapter", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.CHASE_FROM_EMAIL;

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
    if (originalFrom === undefined) delete process.env.CHASE_FROM_EMAIL;
    else process.env.CHASE_FROM_EMAIL = originalFrom;
  });

  test("sends and returns the provider message id", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.CHASE_FROM_EMAIL = "payments@mail.example.test";

    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "msg_123" }), { status: 200 });
    }) as typeof fetch;

    const adapter = new ResendEmailAdapter();
    const result = await adapter.send({
      to: "member@example.test",
      subject: "Payment reminder",
      body: "Hi there",
      idempotencyKey: "chase-email-id-1",
    });

    expect(result.providerMessageId).toBe("msg_123");
    expect(capturedUrl).toBe("https://api.resend.com/emails");

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("chase-email-id-1");
    expect(headers["Authorization"]).toBe("Bearer test-key");

    const payload = JSON.parse(capturedInit.body as string);
    expect(payload.from).toBe("payments@mail.example.test");
    expect(payload.reply_to).toBe("judo@ic.ac.uk");
    expect(payload.to).toBe("member@example.test");
    expect(payload.subject).toBe("Payment reminder");
    expect(payload.text).toBe("Hi there");
  });

  test("throws ResendNotConfiguredError when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.CHASE_FROM_EMAIL = "payments@mail.example.test";

    const adapter = new ResendEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.test", subject: "s", body: "b", idempotencyKey: "k" })
    ).rejects.toThrow(ResendNotConfiguredError);
  });

  test("throws ResendNotConfiguredError when CHASE_FROM_EMAIL is missing", async () => {
    process.env.RESEND_API_KEY = "test-key";
    delete process.env.CHASE_FROM_EMAIL;

    const adapter = new ResendEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.test", subject: "s", body: "b", idempotencyKey: "k" })
    ).rejects.toThrow(ResendNotConfiguredError);
  });

  test("throws ResendApiError when Resend returns a non-2xx response", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.CHASE_FROM_EMAIL = "payments@mail.example.test";
    globalThis.fetch = (async () => new Response("bad request", { status: 422 })) as typeof fetch;

    const adapter = new ResendEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.test", subject: "s", body: "b", idempotencyKey: "k" })
    ).rejects.toThrow(ResendApiError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx playwright test tests/unit/resend-adapter.spec.ts`
Expected: FAIL — `lib/email/resend-adapter` module not found.

- [ ] **Step 4: Write the adapter**

Create `lib/email/resend-adapter.ts`:

```ts
import type { EmailChannelAdapter } from "./types";

const RESEND_API_URL = "https://api.resend.com/emails";
// Fixed regardless of provider -- see design.md's "Decisions already made".
// There is currently exactly one reply destination for this product.
const REPLY_TO = "judo@ic.ac.uk";

export class ResendNotConfiguredError extends Error {
  constructor(missingVar: string) {
    super(`${missingVar} is not set -- cannot send email via Resend.`);
    this.name = "ResendNotConfiguredError";
  }
}

export class ResendApiError extends Error {
  constructor(status: number, body: string) {
    super(`Resend API returned ${status}: ${body}`);
    this.name = "ResendApiError";
  }
}

/**
 * Thin fetch wrapper for Resend's send-email endpoint -- follows this
 * repo's existing convention (see lib/eactivities/client.ts) rather than
 * adding an SDK dependency. Deliberately has NO retry logic: the caller
 * (lib/chase/send.ts) owns failure handling, recording a `failed` status
 * for a human to act on rather than retrying automatically -- see
 * design.md's "Failure handling" decision.
 */
export class ResendEmailAdapter implements EmailChannelAdapter {
  async send(input: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new ResendNotConfiguredError("RESEND_API_KEY");
    const from = process.env.CHASE_FROM_EMAIL;
    if (!from) throw new ResendNotConfiguredError("CHASE_FROM_EMAIL");

    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: input.to,
        reply_to: REPLY_TO,
        subject: input.subject,
        text: input.body,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new ResendApiError(response.status, bodyText);
    }

    const data = (await response.json()) as { id: string };
    return { providerMessageId: data.id };
  }
}

export const resendEmailAdapter = new ResendEmailAdapter();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx playwright test tests/unit/resend-adapter.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/email/types.ts lib/email/resend-adapter.ts tests/unit/resend-adapter.spec.ts
git commit -m "feat(email): add Resend email channel adapter"
```

---

## Task 3: Wire the adapter into `sendChaseEmail` with atomic claim + failure handling

**Files:**
- Modify: `lib/chase/send.ts`
- Test: `tests/integration/chase-send.spec.ts` (extend existing file)

**Interfaces:**
- Consumes: `EmailChannelAdapter` from `lib/email/types.ts`, `resendEmailAdapter` from `lib/email/resend-adapter.ts` (Task 2).
- Produces: `sendChaseEmail(chaseEmailId: string, adapter: EmailChannelAdapter = resendEmailAdapter): Promise<{ sent: boolean; reason?: string }>` — `reason` gains a new possible value `"send_failed"` alongside the existing `"exempt"`, `"debt_cleared"`, `"stale"`. `processAutoSends(adapter: EmailChannelAdapter = resendEmailAdapter): Promise<{ sent: number; cancelled: number; failed: number }>` — also gains an injectable `adapter` param (passed through to every `sendChaseEmail` call it makes), and its return type gains `failed`.

**Why `processAutoSends` also needs an injectable adapter:** before this task, it never touched a real email provider — it just flipped `chase_email.status`. After this task, every row it processes goes through `sendChaseEmail`, which calls the adapter for real. Without a way to inject a fake, the existing `processAutoSends` tests would either make real Resend calls or fail with `ResendNotConfiguredError` in any environment without `RESEND_API_KEY` set — silently turning "sent" into "failed" in a test that doesn't expect that.

- [ ] **Step 1: Write the failing tests**

Open `tests/integration/chase-send.spec.ts` and make three changes.

First, add this import alongside the file's existing imports at the very top:

```ts
import type { EmailChannelAdapter } from "@/lib/email/types";
```

Second, add a `fakeAdapter` helper after the existing helper functions (`createPerson`, `createAttendance`, `createApprovedChaseEmail`) and before `test.describe("sendChaseEmail"...)`:

```ts
function fakeAdapter(overrides?: {
  onSend?: (input: { to: string; subject: string; body: string; idempotencyKey: string }) => void;
  shouldFail?: boolean;
  providerMessageId?: string;
}): EmailChannelAdapter {
  return {
    async send(input) {
      overrides?.onSend?.(input);
      if (overrides?.shouldFail) {
        throw new Error("Resend API returned 422: invalid recipient");
      }
      return { providerMessageId: overrides?.providerMessageId ?? "msg_test_1" };
    },
  };
}
```

Third, add these tests inside `test.describe("sendChaseEmail", ...)`, after the existing `"sends when the person still has outstanding debt"` test:

```ts
  test("calls the adapter with the person's email and the row id as idempotency key, then records provider_message_id", async () => {
    personId = await createPerson();
    await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const chaseEmailId = await createApprovedChaseEmail(personId);

    const { data: person, error: personError } = await admin
      .from("person")
      .select("email")
      .eq("id", personId)
      .single();
    if (personError) throw personError;

    let capturedInput: { to: string; subject: string; body: string; idempotencyKey: string } | null = null;
    const adapter = fakeAdapter({
      onSend: (input) => {
        capturedInput = input;
      },
      providerMessageId: "msg_abc",
    });

    const result = await sendChaseEmail(chaseEmailId, adapter);
    expect(result.sent).toBe(true);
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.to).toBe(person.email);
    expect(capturedInput!.idempotencyKey).toBe(chaseEmailId);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, provider_message_id")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("sent");
    expect(row.provider_message_id).toBe("msg_abc");
  });

  test("marks the row failed when the adapter throws, without auto-retrying", async () => {
    personId = await createPerson();
    await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const chaseEmailId = await createApprovedChaseEmail(personId);

    const result = await sendChaseEmail(chaseEmailId, fakeAdapter({ shouldFail: true }));
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("send_failed");

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, note, provider_message_id")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("failed");
    expect(row.note).toContain("invalid recipient");
    expect(row.provider_message_id).toBeNull();
  });

  test("atomically claims the row so a second concurrent call is stale, not a duplicate send", async () => {
    personId = await createPerson();
    await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const chaseEmailId = await createApprovedChaseEmail(personId);

    let sendCallCount = 0;
    const adapter = fakeAdapter({
      onSend: () => {
        sendCallCount++;
      },
    });

    const [first, second] = await Promise.all([
      sendChaseEmail(chaseEmailId, adapter),
      sendChaseEmail(chaseEmailId, adapter),
    ]);

    const results = [first, second];
    const sentResults = results.filter((r) => r.sent);
    const staleResults = results.filter((r) => !r.sent && r.reason === "stale");
    expect(sentResults.length).toBe(1);
    expect(staleResults.length).toBe(1);
    expect(sendCallCount).toBe(1);
  });
```

Fourth, in `test.describe("processAutoSends"...)`'s test `"processAutoSends does nothing when CHASE_AUTO_SEND_REPEATS is not set"`, update the assertion:

```ts
      const result = await processAutoSends();
      expect(result).toEqual({ sent: 0, cancelled: 0, failed: 0 });
```

(replacing the existing `expect(result).toEqual({ sent: 0, cancelled: 0 });` — no adapter needs to be passed here since the function returns before calling `sendChaseEmail` at all when the flag is unset)

Fifth, in the test `"processAutoSends only touches sequence_number > 1 approved rows"`, pass a fake success adapter so it no longer depends on a real Resend call:

```ts
      const result = await processAutoSends(fakeAdapter());
```

(replacing the existing `const result = await processAutoSends();`)

Sixth, add two new tests in the same `test.describe("processAutoSends"...)` block, after that one — a mixed batch, and a failure case:

```ts
  test("a mixed batch of success/failure/cancellation is reflected in the returned counts", async () => {
    const originalFlag = process.env.CHASE_AUTO_SEND_REPEATS;
    process.env.CHASE_AUTO_SEND_REPEATS = "true";
    try {
      personId = await createPerson();
      await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
      await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));

      const willSucceed = await createApprovedChaseEmail(personId, 2);

      const otherPersonId = await createPerson();
      // No attendance for this person -- debt is 0, so this row cancels
      // before the adapter is ever called, regardless of adapter outcome.
      const willCancel = await createApprovedChaseEmail(otherPersonId, 2);

      let callCount = 0;
      // Always-succeeds fake -- the cancelled row never reaches this at
      // all (debt_cleared short-circuits before any adapter call), so a
      // single always-succeeding fake is enough to prove both outcomes.
      const adapter = fakeAdapter({ onSend: () => { callCount++; } });

      const result = await processAutoSends(adapter);
      expect(result.sent).toBe(1);
      expect(result.cancelled).toBe(1);
      expect(result.failed).toBe(0);
      expect(callCount).toBe(1); // the cancelled row never reached the adapter

      const { data: succeededRow, error: succeededError } = await admin
        .from("chase_email")
        .select("status")
        .eq("id", willSucceed)
        .single();
      if (succeededError) throw succeededError;
      expect(succeededRow.status).toBe("sent");

      const { data: cancelledRow, error: cancelledError } = await admin
        .from("chase_email")
        .select("status")
        .eq("id", willCancel)
        .single();
      if (cancelledError) throw cancelledError;
      expect(cancelledRow.status).toBe("cancelled");

      const { error: cleanupError } = await admin.from("chase_email").delete().eq("person_id", otherPersonId);
      if (cleanupError) throw cleanupError;
      const { error: personCleanupError } = await admin.from("person").delete().eq("id", otherPersonId);
      if (personCleanupError) throw personCleanupError;
    } finally {
      if (originalFlag === undefined) delete process.env.CHASE_AUTO_SEND_REPEATS;
      else process.env.CHASE_AUTO_SEND_REPEATS = originalFlag;
    }
  });

  test("a failing adapter is reflected in the failed count, not cancelled", async () => {
    const originalFlag = process.env.CHASE_AUTO_SEND_REPEATS;
    process.env.CHASE_AUTO_SEND_REPEATS = "true";
    try {
      personId = await createPerson();
      await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
      await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
      const chaseEmailId = await createApprovedChaseEmail(personId, 2);

      const result = await processAutoSends(fakeAdapter({ shouldFail: true }));
      expect(result.sent).toBe(0);
      expect(result.cancelled).toBe(0);
      expect(result.failed).toBe(1);

      const { data: row, error } = await admin
        .from("chase_email")
        .select("status")
        .eq("id", chaseEmailId)
        .single();
      if (error) throw error;
      expect(row.status).toBe("failed");
    } finally {
      if (originalFlag === undefined) delete process.env.CHASE_AUTO_SEND_REPEATS;
      else process.env.CHASE_AUTO_SEND_REPEATS = originalFlag;
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:integration -- tests/integration/chase-send.spec.ts`
Expected: FAIL — `sendChaseEmail` doesn't accept a second `adapter` argument yet, `provider_message_id` update never happens, no `stale`/`send_failed` reasons exist yet, and the `processAutoSends` assertion mismatches the current `{ sent, cancelled }` shape.

- [ ] **Step 3: Rewrite `lib/chase/send.ts`**

Replace the full file contents:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import type { EmailChannelAdapter } from "@/lib/email/types";
import { resendEmailAdapter } from "@/lib/email/resend-adapter";

// Session addition (not in the original tasks.md text, requested directly
// this session): re-check live debt immediately before sending. A chase
// email can sit approved for days; if the person paid in the meantime, this
// cancels the send instead of chasing a cleared debt. See design.md's
// "Pre-send debt recheck" architecture decision.
//
// `adapter` defaults to the real Resend adapter but is overridable so
// tests can inject a fake -- see docs/superpowers/specs/2026-09-23-
// chase-email-sending-design.md.
export async function sendChaseEmail(
  chaseEmailId: string,
  adapter: EmailChannelAdapter = resendEmailAdapter
): Promise<{ sent: boolean; reason?: string }> {
  const admin = createAdminClient();

  const { data: row, error: fetchError } = await admin
    .from("chase_email")
    .select("id, person_id, status, subject, body")
    .eq("id", chaseEmailId)
    .single();

  if (fetchError) {
    throw new Error(`Failed to fetch chase_email ${chaseEmailId}: ${fetchError.message}`);
  }
  if (row.status !== "approved") {
    throw new Error(
      `chase_email ${chaseEmailId} is not approved (status: ${row.status}) -- refusing to send`
    );
  }

  const { data: person, error: personError } = await admin
    .from("person")
    .select("is_exempt, email")
    .eq("id", row.person_id)
    .single();
  if (personError) {
    throw new Error(`Failed to fetch person ${row.person_id}: ${personError.message}`);
  }

  if (person.is_exempt) {
    const { error: cancelError } = await admin
      .from("chase_email")
      .update({
        status: "cancelled",
        note: "Auto-cancelled: person was exempted before send.",
      })
      .eq("id", chaseEmailId)
      .eq("status", "approved");
    if (cancelError) {
      throw new Error(`Failed to cancel chase_email ${chaseEmailId}: ${cancelError.message}`);
    }
    return { sent: false, reason: "exempt" };
  }

  const debt = await getOutstandingDebt(row.person_id);

  if (debt <= 0) {
    const { error: cancelError } = await admin
      .from("chase_email")
      .update({
        status: "cancelled",
        note: "Auto-cancelled: debt was already cleared before send.",
      })
      .eq("id", chaseEmailId)
      .eq("status", "approved");
    if (cancelError) {
      throw new Error(`Failed to cancel chase_email ${chaseEmailId}: ${cancelError.message}`);
    }
    return { sent: false, reason: "debt_cleared" };
  }

  // Atomic claim: flips this row from 'approved' to 'sending' before any
  // Resend call is made. If the cron and a manual "Send" click race on the
  // same row, only one caller's conditional update affects a row -- the
  // other affects zero rows and bails out as 'stale'. See design.md's
  // "Atomic claim before sending" decision.
  const { data: claimedRows, error: claimError } = await admin
    .from("chase_email")
    .update({ status: "sending" })
    .eq("id", chaseEmailId)
    .eq("status", "approved")
    .select("id");
  if (claimError) {
    throw new Error(`Failed to claim chase_email ${chaseEmailId} for sending: ${claimError.message}`);
  }
  if ((claimedRows?.length ?? 0) === 0) {
    return { sent: false, reason: "stale" };
  }

  try {
    // idempotencyKey = this row's id, reused across any retry attempt for
    // the same row -- a second attempt (e.g. after a failed status write
    // below) can't produce a real duplicate email. See design.md's
    // "Idempotency key on the Resend call" decision.
    const { providerMessageId } = await adapter.send({
      to: person.email,
      subject: row.subject,
      body: row.body,
      idempotencyKey: chaseEmailId,
    });

    const { error: sendError } = await admin
      .from("chase_email")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: providerMessageId,
      })
      .eq("id", chaseEmailId);
    if (sendError) {
      throw new Error(`Failed to record sent chase_email ${chaseEmailId}: ${sendError.message}`);
    }
    return { sent: true };
  } catch (sendAttemptError) {
    // Covers both an adapter.send() rejection and a failed status write
    // after a successful send -- either way, a human needs to see this
    // and decide whether to retry (never automatic; see "Failure
    // handling" in the design doc). A retry reuses the same
    // idempotencyKey above, so it's safe even if the email actually went
    // out the first time.
    const message =
      sendAttemptError instanceof Error ? sendAttemptError.message : String(sendAttemptError);
    const { error: failError } = await admin
      .from("chase_email")
      .update({ status: "failed", note: message.slice(0, 1000) })
      .eq("id", chaseEmailId);
    if (failError) {
      throw new Error(`Failed to record failed chase_email ${chaseEmailId}: ${failError.message}`);
    }
    return { sent: false, reason: "send_failed" };
  }
}

// DC-4's auto-send path: every repeat reminder (sequence_number > 1) that
// generateChaseEmails() pre-approved under CHASE_AUTO_SEND_REPEATS. Never
// touches sequence_number = 1 rows -- those always require manual approval
// (DC-3) and reach `approved` only through a future Phase 7 admin action.
export async function processAutoSends(
  adapter: EmailChannelAdapter = resendEmailAdapter
): Promise<{
  sent: number;
  cancelled: number;
  failed: number;
}> {
  if (process.env.CHASE_AUTO_SEND_REPEATS !== "true") {
    return { sent: 0, cancelled: 0, failed: 0 };
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("chase_email")
    .select("id")
    .eq("status", "approved")
    .gt("sequence_number", 1);

  if (error) {
    throw new Error(`Failed to list auto-sendable chase emails: ${error.message}`);
  }

  const rowsToSend = rows ?? [];
  let sent = 0;
  let cancelled = 0;
  let failed = 0;

  for (let i = 0; i < rowsToSend.length; i++) {
    const result = await sendChaseEmail(rowsToSend[i].id, adapter);
    if (result.sent) sent++;
    else if (result.reason === "send_failed") failed++;
    else cancelled++;

    // Small delay between sends to stay comfortably under Resend's
    // per-second rate limit -- cheap at this scale (a society's debtor
    // list is tens of rows, not thousands). NOTE: if the debtor list ever
    // grows substantially, a serial delay loop inside one Vercel function
    // invocation could approach its execution timeout -- not a concern
    // today, but worth revisiting if batch size changes materially. See
    // design.md's "Rate limiting" section.
    if (i < rowsToSend.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return { sent, cancelled, failed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:integration -- tests/integration/chase-send.spec.ts`
Expected: PASS (all tests in the file, including the 3 new ones and the updated `processAutoSends` assertion)

- [ ] **Step 5: Commit**

```bash
git add lib/chase/send.ts tests/integration/chase-send.spec.ts
git commit -m "feat(chase): send real email via Resend with atomic claim and failed-status handling"
```

---

## Task 4: Failed-email retry path (chase inbox + approval writer)

**Files:**
- Modify: `lib/chase/approval-writer.ts`
- Modify: `app/admin/chase-inbox/page.tsx`
- Modify: `components/chase/approval-actions.tsx`
- Test: `tests/integration/chase-approval.spec.ts` (extend existing file)

**Interfaces:**
- Consumes: none new.
- Produces: `approveChaseEmail(chaseEmailId: string, actorEmail: string): Promise<{ approved: boolean }>` now also approves rows with `status = 'failed'` (in addition to `'pending_approval'`), moving them to `'approved'` so `sendChaseEmail` can retry them.

- [ ] **Step 1: Write the failing test**

In `tests/integration/chase-approval.spec.ts`, add this test inside `test.describe("approveChaseEmail", ...)`, after the existing `"is a no-op on a row that is not pending_approval"` test:

```ts
  test("re-approves a failed row so it becomes retryable", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "failed");

    const result = await approveChaseEmail(chaseEmailId, TEST_ADMIN_EMAIL);
    expect(result.approved).toBe(true);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, approved_by")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("approved");
    expect(row.approved_by).toBe(TEST_ADMIN_EMAIL);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- tests/integration/chase-approval.spec.ts`
Expected: FAIL — `approveChaseEmail`'s current `.eq("status", "pending_approval")` filter doesn't match a `'failed'` row, so `result.approved` is `false`.

- [ ] **Step 3: Update `approveChaseEmail`**

In `lib/chase/approval-writer.ts`, change:

```ts
  const { data, error } = await admin
    .from("chase_email")
    .update({ status: "approved", approved_by: actorEmail, approved_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .eq("status", "pending_approval")
    .select("id");
```

to:

```ts
  const { data, error } = await admin
    .from("chase_email")
    .update({ status: "approved", approved_by: actorEmail, approved_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .in("status", ["pending_approval", "failed"])
    .select("id");
```

And update the comment above `approveChaseEmail` (currently describing DC-3/reject-cancel) to note the retry path:

```ts
// The actual database writes for DC-3 (approve) and the reject/cancel path
// (core/RULES.md §10: every rejected draft preserves reviewer feedback).
// approveChaseEmail also re-approves a 'failed' row -- see
// docs/superpowers/specs/2026-09-23-chase-email-sending-design.md's
// "Failure handling": retry is always this manual re-approval, never
// automatic.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- tests/integration/chase-approval.spec.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Show `failed` rows in the chase inbox**

In `app/admin/chase-inbox/page.tsx`, change the query's status filter and selected columns:

```ts
  const { data: chaseEmails } = await admin
    .from("chase_email")
    .select("id, person_id, sequence_number, status, subject, body, note, created_at")
    .in("status", ["pending_approval", "approved", "failed"])
    .order("created_at", { ascending: true });
```

(adds `"note"` to the select list and `"failed"` to the status filter)

Then, in the row rendering, after the existing `<p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.body}</p>` line, add:

```tsx
                  {c.status === "failed" && c.note && (
                    <p className="mt-2 text-sm text-destructive">Send failed: {c.note}</p>
                  )}
```

- [ ] **Step 6: Let a failed row be retried from the UI**

In `components/chase/approval-actions.tsx`, change:

```tsx
      {status === "pending_approval" && (
        <Button type="button" size="sm" disabled={isLoading} onClick={handleApprove}>
          Approve
        </Button>
      )}
```

to:

```tsx
      {(status === "pending_approval" || status === "failed") && (
        <Button type="button" size="sm" disabled={isLoading} onClick={handleApprove}>
          {status === "failed" ? "Retry" : "Approve"}
        </Button>
      )}
```

- [ ] **Step 7: Manually verify the UI compiles and renders**

Run `npm run dev`, sign in, open `/admin/chase-inbox`. Confirm the page loads with no console errors. If `RESEND_API_KEY`/`CHASE_FROM_EMAIL` aren't set locally yet (Task 6 hasn't been done), clicking "Send" on an approved draft will genuinely fail (`ResendNotConfiguredError`, by design — see the Rollout section of the design doc) and produce a real `failed` row you can use to confirm this task's rendering and "Retry" button.

- [ ] **Step 8: Commit**

```bash
git add lib/chase/approval-writer.ts app/admin/chase-inbox/page.tsx components/chase/approval-actions.tsx tests/integration/chase-approval.spec.ts
git commit -m "feat(chase): allow retrying a failed chase email from the approval inbox"
```

---

## Task 5: Failed-send count badge on `/sessions`

**Files:**
- Create: `lib/chase/queries.ts`
- Modify: `app/sessions/page.tsx`
- Test: `tests/integration/chase-queries.spec.ts`

**Interfaces:**
- Produces: `countFailedChaseEmails(): Promise<number>` from `lib/chase/queries.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/chase-queries.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { countFailedChaseEmails } from "@/lib/chase/queries";

const admin = createAdminClient();

async function createPerson() {
  const email = `chase-queries-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Chase Queries Test Person", email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createChaseEmail(personId: string, status: string) {
  const { data, error } = await admin
    .from("chase_email")
    .insert({
      person_id: personId,
      debt_cycle_started_at: new Date().toISOString(),
      sequence_number: 1,
      status,
      subject: "test",
      body: "test",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("countFailedChaseEmails", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("counts only failed rows, not other statuses", async () => {
    const before = await countFailedChaseEmails();

    personId = await createPerson();
    await createChaseEmail(personId, "failed");
    await createChaseEmail(personId, "sent");
    await createChaseEmail(personId, "approved");

    const after = await countFailedChaseEmails();
    expect(after).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- tests/integration/chase-queries.spec.ts`
Expected: FAIL — `lib/chase/queries` module not found.

- [ ] **Step 3: Write `lib/chase/queries.ts`**

```ts
import { createAdminClient } from "@/lib/supabase/admin";

// Backs the failed-send badge on /sessions (see design.md's "Failure
// visibility" decision) -- an admin lands there first and should see a
// failure without having to proactively open the chase inbox.
export async function countFailedChaseEmails(): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("chase_email")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed");

  if (error) {
    throw new Error(`Failed to count failed chase emails: ${error.message}`);
  }
  return count ?? 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- tests/integration/chase-queries.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the badge to `/sessions`**

In `app/sessions/page.tsx`, add the import:

```ts
import { countFailedChaseEmails } from "@/lib/chase/queries";
```

Change:

```ts
  const sessions = await listRecentSessions();
```

to:

```ts
  const [sessions, failedChaseCount] = await Promise.all([
    listRecentSessions(),
    countFailedChaseEmails(),
  ]);
```

Change:

```tsx
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/chase-inbox">Chase inbox</Link>
          </Button>
```

to:

```tsx
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/chase-inbox" className="flex items-center gap-2">
              Chase inbox
              {failedChaseCount > 0 && (
                <Badge variant="destructive">{failedChaseCount} failed</Badge>
              )}
            </Link>
          </Button>
```

(`Badge` is already imported in this file for `SessionRow`.)

- [ ] **Step 6: Manually verify**

Run `npm run dev`, sign in, load `/sessions`. With no failed chase emails, the "Chase inbox" link shows no badge. Temporarily insert a `chase_email` row with `status = 'failed'` via the Supabase dashboard or `execute_sql`, reload, confirm the badge appears with the right count, then delete that test row.

- [ ] **Step 7: Commit**

```bash
git add lib/chase/queries.ts app/sessions/page.tsx tests/integration/chase-queries.spec.ts
git commit -m "feat(chase): show a failed-send count badge on the sessions page"
```

---

## Task 6: Operational setup (not code — do once, outside this plan's commits)

These steps depend on the domain/Resend account being ready and are not automatable from this repo:

1. In Resend's dashboard, verify the subdomain (e.g. `mail.<yourdomain>`) with the DNS records Resend provides.
2. Create an API key scoped to sending-only permissions (per Global Constraints above), and set `RESEND_API_KEY` in `.env.local` and in the Vercel project's environment variables (Production + any other environments that send real email).
3. Set `CHASE_FROM_EMAIL` (e.g. `payments@mail.<yourdomain>`) in the same two places.
4. Once confirmed nothing else reads `GMAIL_USER` / `GMAIL_APP_PASSWORD` (auth is password-based; chase email now uses Resend — see Task 3), remove both from `.env.local` and from the Vercel project's environment variables.
5. Send one real chase email end-to-end (approve a real or test draft in `/admin/chase-inbox` and click Send) and confirm it lands in an Imperial inbox without being spam-filtered, given the deliverability history this design was built to avoid repeating.
