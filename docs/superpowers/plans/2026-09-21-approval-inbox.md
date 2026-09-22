# Approval Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an admin a single page to review, approve, send, and reject `chase_email` drafts, closing out DC-3 and DC-4.

**Architecture:** A plain (non-`"use server"`) writer module (`lib/chase/approval-writer.ts`) holds the two new DB writes (approve, reject); a thin `"use server"` file (`lib/chase/actions.ts`) gates all three actions (approve, send, reject) behind `requireAdmin()` and delegates — send delegates to the already-built `sendChaseEmail()` from Phase 6, approve/reject delegate to the new writer. A server-component page (`app/admin/chase-inbox/page.tsx`) lists every `chase_email` row that still needs human attention (`pending_approval` or `approved`-but-unsent) alongside its person's name/email, and a client component renders the per-row action buttons.

**Tech Stack:** Next.js App Router (Server Actions), Supabase (service-role admin client), Zod, Playwright (integration + e2e), shadcn/ui primitives already in the repo (`Button`, `Table`, `Textarea`).

**Spec:** `specs/attendance-payment-chasing/design.md`, `specs/attendance-payment-chasing/requirements.md`, `specs/attendance-payment-chasing/tasks.md` (Phase 7), `core/RULES.md` §10.

## Global Constraints

- **No new DB columns or tables.** `chase_email.note` (added in Phase 6, migration `20260921100000`) is the reviewer-feedback field RULES.md §10 requires for a rejected draft — reuse it verbatim, do not add a `rejected_by`/`rejection_reason` column.
- **`"use server"` files must contain only thin, `requireAdmin()`-gated wrappers.** Every export of a `"use server"` file is a reachable Server Action by reference regardless of whether UI code calls it — a real authorization-bypass gap of exactly this shape was found and fixed in Phase 6 (see `lib/person/actions.ts` + `lib/person/exempt-writer.ts` for the established, working split). All actual database writes for this plan live in `lib/chase/approval-writer.ts`, which has no `"use server"` directive. `lib/chase/send.ts`'s `sendChaseEmail` is already a plain function from Phase 6 — do not add `"use server"` to that file; gate it from `lib/chase/actions.ts` instead.
- **Admin identity is `requireAdmin(): Promise<{email: string}>`** from `lib/auth/require-admin.ts` — any admin may act, no per-admin restriction. It throws `UnauthorizedError` when the caller isn't on `admin_allowlist`.
- **`chase_email.status` check constraint** allows exactly: `'draft' | 'pending_approval' | 'approved' | 'sent' | 'cancelled'` (migration `20260914151353`).
- **Every DB write in this plan is a conditional update** (`.eq("status", <expected-current-status>)` alongside `.eq("id", ...)`) so a stale/already-actioned row is a no-op rather than a silent overwrite — this matches the guard pattern `sendChaseEmail` already uses (`.eq("status", "approved")` on its own updates).
- **Test hygiene (established this session, non-negotiable):** every integration test inserts/deletes its own rows; `afterEach` deletes in FK-safe order and checks/throws on every delete's error; any `session` row created for test attendance must be tracked in a module-level array and deleted by id (sessions have no `person_id` column). See `tests/integration/chase-send.spec.ts` for the exact pattern to copy.
- **No new admin UI framework or client-state library.** Match `app/admin/purchases/page.tsx`'s style: async server component, `requireAdmin()` in a try/catch redirecting to `/login` on `UnauthorizedError`, `createAdminClient()` queries, plain `<table>`/shadcn primitives. Match `components/purchase/xlsx-uploader.tsx`'s style for the client action component: `"use client"`, local `useState` for a per-button loading flag, `sonner`'s `toast` for success/error, call the Server Action directly as an imported async function (not a `<form action>`).
- **Known limitation, not to be fixed here (Phase 6 final-review TRACKED GAP, documented in `design.md`):** a `cancelled` `chase_email` currently has no defined path back to being chased again in a later cycle, and a `session_pass`'s partial-payment waiver can advance a debt cycle's identity out from under an in-flight `chase_email`. This plan's reject action produces exactly the `cancelled` status this gap concerns. Flag it with a one-line code comment near the reject writer function — do not redesign cycle/cancellation semantics as part of this plan.
- **Inbox scope decision:** Task 7.1's literal text is "listing rows with `status = 'pending_approval'`", but 7.2 (approve) and 7.3 (send) are separate actions — an admin needs to see and act on `approved`-but-not-yet-sent rows too, or the only way to send a manually-approved email would be the auto-send cron (which never touches `sequence_number = 1` rows). The inbox therefore lists `status IN ('pending_approval', 'approved')`, ordered by `created_at` ascending (oldest first). This is a superset of 7.1's literal query, not a narrower or different one.

---

### Task 1: Approval writer functions

**Files:**
- Create: `lib/chase/approval-writer.ts`
- Test: `tests/integration/chase-approval.spec.ts`

**Interfaces:**
- Consumes: `createAdminClient()` from `@/lib/supabase/admin` (returns a Supabase client with `.from(table).select/update/insert(...)`, same as used throughout `lib/chase/send.ts` and `lib/chase/generator.ts`).
- Produces:
  - `approveChaseEmail(chaseEmailId: string, actorEmail: string): Promise<{ approved: boolean }>` — for later tasks (the `"use server"` wrapper in Task 2).
  - `rejectChaseEmail(chaseEmailId: string, note: string, actorEmail: string): Promise<{ rejected: boolean }>` — for later tasks (the `"use server"` wrapper in Task 2).
  - Both return `{ approved: false }` / `{ rejected: false }` (rather than throwing) when the row was not in the expected starting status — the same "stale action is a no-op, not an error" convention `sendChaseEmail` already uses for its exempt/debt-cleared cancellations.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/chase-approval.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { approveChaseEmail, rejectChaseEmail } from "@/lib/chase/approval-writer";

const TEST_ADMIN_EMAIL = "test-admin@example.test";
const admin = createAdminClient();

async function createPerson() {
  const email = `chase-approval-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Chase Approval Test Person", email, is_exempt: false })
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

test.describe("approveChaseEmail", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("approves a pending_approval row and records approved_by/approved_at", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "pending_approval");

    const result = await approveChaseEmail(chaseEmailId, TEST_ADMIN_EMAIL);
    expect(result.approved).toBe(true);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, approved_by, approved_at")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("approved");
    expect(row.approved_by).toBe(TEST_ADMIN_EMAIL);
    expect(row.approved_at).not.toBeNull();
  });

  test("is a no-op on a row that is not pending_approval", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "sent");

    const result = await approveChaseEmail(chaseEmailId, TEST_ADMIN_EMAIL);
    expect(result.approved).toBe(false);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, approved_by")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("sent"); // untouched
    expect(row.approved_by).toBeNull();
  });
});

test.describe("rejectChaseEmail", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("rejects a pending_approval row and preserves the reviewer's note", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "pending_approval");

    const result = await rejectChaseEmail(chaseEmailId, "Wrong person, they already paid in cash.", TEST_ADMIN_EMAIL);
    expect(result.rejected).toBe(true);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, note")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("cancelled");
    expect(row.note).toBe("Wrong person, they already paid in cash.");
  });

  test("rejects an approved (not yet sent) row too", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "approved");

    const result = await rejectChaseEmail(chaseEmailId, "Duplicate draft.", TEST_ADMIN_EMAIL);
    expect(result.rejected).toBe(true);

    const { data: row, error } = await admin.from("chase_email").select("status").eq("id", chaseEmailId).single();
    if (error) throw error;
    expect(row.status).toBe("cancelled");
  });

  test("is a no-op on a row that is already sent", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "sent");

    const result = await rejectChaseEmail(chaseEmailId, "too late", TEST_ADMIN_EMAIL);
    expect(result.rejected).toBe(false);

    const { data: row, error } = await admin.from("chase_email").select("status, note").eq("id", chaseEmailId).single();
    if (error) throw error;
    expect(row.status).toBe("sent"); // untouched
    expect(row.note).toBeNull();
  });

  test("rejects the empty-string note as invalid input", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "pending_approval");

    await expect(rejectChaseEmail(chaseEmailId, "", TEST_ADMIN_EMAIL)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:integration -- chase-approval`
Expected: FAIL — `Cannot find module '@/lib/chase/approval-writer'` (the module doesn't exist yet).

- [ ] **Step 3: Implement `lib/chase/approval-writer.ts`**

```typescript
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

const rejectChaseEmailSchema = z.object({
  chaseEmailId: z.string().uuid(),
  note: z.string().min(1).max(1000),
  actorEmail: z.string(),
});

// The actual database writes for DC-3 (approve) and the reject/cancel path
// (core/RULES.md §10: every rejected draft preserves reviewer feedback).
// Deliberately NOT in a "use server" file: every export of a "use server"
// module is a reachable Server Action by reference, regardless of whether
// anything currently imports it, so authorization-sensitive logic must
// never live there unguarded. This plain module is imported by both the
// admin-gated Server Actions (lib/chase/actions.ts) and integration tests.
//
// Both writes are conditional on the row's current status: acting on an
// already-actioned row (approved twice, rejected after being sent, etc.)
// is a no-op, not an error -- the same convention lib/chase/send.ts uses
// for its own guarded updates.

export async function approveChaseEmail(
  chaseEmailId: string,
  actorEmail: string
): Promise<{ approved: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("chase_email")
    .update({ status: "approved", approved_by: actorEmail, approved_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .eq("status", "pending_approval")
    .select("id");

  if (error) {
    throw new Error(`Failed to approve chase_email ${chaseEmailId}: ${error.message}`);
  }
  return { approved: (data?.length ?? 0) > 0 };
}

// Known limitation (Phase 6 final-review TRACKED GAP, see design.md): once
// cancelled here, this cycle has no defined path back to being chased
// again if the person's debt persists or recurs -- not addressed by this
// function.
export async function rejectChaseEmail(
  chaseEmailId: string,
  note: string,
  actorEmail: string
): Promise<{ rejected: boolean }> {
  const parsed = rejectChaseEmailSchema.parse({ chaseEmailId, note, actorEmail });
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("chase_email")
    .update({ status: "cancelled", note: parsed.note })
    .eq("id", parsed.chaseEmailId)
    .in("status", ["pending_approval", "approved"])
    .select("id");

  if (error) {
    throw new Error(`Failed to reject chase_email ${chaseEmailId}: ${error.message}`);
  }
  return { rejected: (data?.length ?? 0) > 0 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:integration -- chase-approval`
Expected: PASS (7 tests: 2 approve, 5 reject).

- [ ] **Step 5: Commit**

```bash
git add lib/chase/approval-writer.ts tests/integration/chase-approval.spec.ts
git commit -m "feat(chase): add approve/reject writer functions (DC-3, RULES §10)"
```

---

### Task 2: Admin-gated Server Actions

**Files:**
- Create: `lib/chase/actions.ts`

**Interfaces:**
- Consumes: `approveChaseEmail`, `rejectChaseEmail` from `@/lib/chase/approval-writer` (Task 1); `sendChaseEmail` from `@/lib/chase/send.ts` (already built in Phase 6, signature `sendChaseEmail(chaseEmailId: string): Promise<{ sent: boolean; reason?: string }>`); `requireAdmin` from `@/lib/auth/require-admin`.
- Produces (for Task 3's client component):
  - `approveChase(chaseEmailId: string): Promise<{ approved: boolean }>`
  - `sendChase(chaseEmailId: string): Promise<{ sent: boolean; reason?: string }>`
  - `rejectChase(chaseEmailId: string, note: string): Promise<{ rejected: boolean }>`

There is no test file for this task. `lib/person/actions.ts` (the Phase 6 precedent for this exact split) has no dedicated test either — a `"use server"` wrapper needs a real Next.js request context to exercise meaningfully, and the logic it wraps is already covered (Task 1's tests for approve/reject, Phase 6's `tests/integration/chase-send.spec.ts` for send). This task's correctness is verified by the task reviewer reading the diff, and by Task 3's e2e gating test exercising the page these actions are wired into.

- [ ] **Step 1: Implement `lib/chase/actions.ts`**

```typescript
"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { approveChaseEmail, rejectChaseEmail } from "@/lib/chase/approval-writer";
import { sendChaseEmail } from "@/lib/chase/send";

// DC-3/DC-4: an admin approves, sends, or rejects a chase_email draft from
// the approval inbox (app/admin/chase-inbox/page.tsx). The actual writes
// live in lib/chase/approval-writer.ts and lib/chase/send.ts, both plain
// (non-"use server") modules -- every export of a "use server" file is a
// reachable Server Action by reference, so authorization-sensitive logic
// must never be exported from here unguarded. These three wrappers are
// this file's only exports.

export async function approveChase(chaseEmailId: string): Promise<{ approved: boolean }> {
  const admin = await requireAdmin();
  return approveChaseEmail(chaseEmailId, admin.email);
}

export async function sendChase(chaseEmailId: string): Promise<{ sent: boolean; reason?: string }> {
  await requireAdmin();
  return sendChaseEmail(chaseEmailId);
}

export async function rejectChase(chaseEmailId: string, note: string): Promise<{ rejected: boolean }> {
  const admin = await requireAdmin();
  return rejectChaseEmail(chaseEmailId, note, admin.email);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/chase/actions.ts
git commit -m "feat(chase): admin-gated approve/send/reject Server Actions"
```

---

### Task 3: Approval inbox page + action buttons

**Files:**
- Create: `app/admin/chase-inbox/page.tsx`
- Create: `components/chase/approval-actions.tsx`
- Modify: `tests/e2e/admin-auth-gate.spec.ts` (add `/admin/chase-inbox` to the gated-routes list)

**Interfaces:**
- Consumes: `approveChase`, `sendChase`, `rejectChase` from `@/lib/chase/actions` (Task 2); `requireAdmin`, `UnauthorizedError` from `@/lib/auth/require-admin`; `createAdminClient` from `@/lib/supabase/admin`; `Button` from `@/components/ui/button`; `Textarea` from `@/components/ui/textarea`; `toast` from `sonner`.
- Produces: nothing consumed by a later task — this is the final task in the plan.

- [ ] **Step 1: Implement the action-buttons client component**

Create `components/chase/approval-actions.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approveChase, sendChase, rejectChase } from "@/lib/chase/actions";

export function ApprovalActions({ chaseEmailId, status }: { chaseEmailId: string; status: string }) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  async function handleApprove() {
    setIsLoading(true);
    try {
      const result = await approveChase(chaseEmailId);
      if (result.approved) {
        toast.success("Approved.");
        router.refresh();
      } else {
        toast.error("Could not approve -- this draft may have already been actioned.");
      }
    } catch {
      toast.error("Approve failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSend() {
    setIsLoading(true);
    try {
      const result = await sendChase(chaseEmailId);
      if (result.sent) {
        toast.success("Sent.");
      } else {
        toast.error(`Not sent -- ${result.reason === "exempt" ? "person is now exempt" : "debt was already cleared"}.`);
      }
      router.refresh();
    } catch {
      toast.error("Send failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleReject() {
    if (!note.trim()) {
      toast.error("A note is required to reject a draft.");
      return;
    }
    setIsLoading(true);
    try {
      const result = await rejectChase(chaseEmailId, note.trim());
      if (result.rejected) {
        toast.success("Rejected.");
        setRejecting(false);
        setNote("");
        router.refresh();
      } else {
        toast.error("Could not reject -- this draft may have already been actioned.");
      }
    } catch {
      toast.error("Reject failed.");
    } finally {
      setIsLoading(false);
    }
  }

  if (rejecting) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why is this being rejected? (required)"
          disabled={isLoading}
          rows={2}
        />
        <div className="flex gap-2">
          <Button type="button" variant="destructive" size="sm" disabled={isLoading} onClick={handleReject}>
            Confirm reject
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      {status === "pending_approval" && (
        <Button type="button" size="sm" disabled={isLoading} onClick={handleApprove}>
          Approve
        </Button>
      )}
      {status === "approved" && (
        <Button type="button" size="sm" disabled={isLoading} onClick={handleSend}>
          Send
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={() => setRejecting(true)}>
        Reject
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Implement the page**

Create `app/admin/chase-inbox/page.tsx`:

```typescript
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApprovalActions } from "@/components/chase/approval-actions";

export const dynamic = "force-dynamic";

export default async function ChaseInboxPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const admin = createAdminClient();
  const { data: chaseEmails } = await admin
    .from("chase_email")
    .select("id, person_id, sequence_number, status, subject, body, created_at")
    .in("status", ["pending_approval", "approved"])
    .order("created_at", { ascending: true });

  const personIds = [...new Set((chaseEmails ?? []).map((c) => c.person_id))];
  const { data: people } =
    personIds.length > 0
      ? await admin.from("person").select("id, full_name, email").in("id", personIds)
      : { data: [] };
  const peopleById = new Map((people ?? []).map((p) => [p.id, p]));

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Chase Email Approval Inbox</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Drafts awaiting approval, and approved drafts awaiting send.
      </p>

      <div className="mt-8 space-y-4">
        {chaseEmails && chaseEmails.length > 0 ? (
          chaseEmails.map((c) => {
            const person = peopleById.get(c.person_id);
            return (
              <div key={c.id} className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">
                      {person?.full_name ?? "Unknown"} ({person?.email ?? "unknown"})
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Reminder #{c.sequence_number} -- {c.status}
                    </p>
                  </div>
                  <ApprovalActions chaseEmailId={c.id} status={c.status} />
                </div>
                <div className="mt-3 text-sm">
                  <p className="font-medium">{c.subject}</p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.body}</p>
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-sm text-muted-foreground">Nothing awaiting approval or send.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the new route to the admin gating e2e test**

Modify `tests/e2e/admin-auth-gate.spec.ts` — change the `for` loop's array from:

```typescript
  for (const path of ["/sessions/new", "/admin/purchases"]) {
```

to:

```typescript
  for (const path of ["/sessions/new", "/admin/purchases", "/admin/chase-inbox"]) {
```

- [ ] **Step 4: Run the e2e gating test**

Run: `npm run test:e2e -- admin-auth-gate`
Expected: PASS (3 routes, all redirect to `/login`).

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/admin/chase-inbox/page.tsx components/chase/approval-actions.tsx tests/e2e/admin-auth-gate.spec.ts
git commit -m "feat(chase): approval inbox page with approve/send/reject actions"
```

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage:** 7.1 (list `pending_approval`, superset-scoped per the documented decision) → Task 3. 7.2 (approve: status/approved_by/approved_at) → Task 1 + Task 2. 7.3 (send: status/sent_at, audit via existing columns) → Task 2, reusing Phase 6's `sendChaseEmail`. 7.4 (reject: status='cancelled', preserve feedback per RULES §10) → Task 1 (writer, using the existing `note` column) + Task 2 (wrapper) + Task 3 (UI requiring a non-empty note).
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type consistency:** `approveChaseEmail`/`rejectChaseEmail` signatures in Task 1 match exactly what Task 2's `lib/chase/actions.ts` imports and calls; Task 2's exported action signatures match exactly what Task 3's `ApprovalActions` component imports and calls; `sendChaseEmail`'s pre-existing signature (`Promise<{ sent: boolean; reason?: string }>`) is passed through unchanged by `sendChase`.
