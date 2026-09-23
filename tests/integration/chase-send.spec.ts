import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendChaseEmail, processAutoSends } from "@/lib/chase/send";
import type { EmailChannelAdapter } from "@/lib/email/types";

const admin = createAdminClient();
let sessionIds: string[] = [];

async function createPerson() {
  const email = `chase-send-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Chase Send Test Person", email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createAttendance(personId: string, startsAt: Date) {
  const { data: session, error: sessionError } = await admin
    .from("session")
    .insert({ title: "Chase Send Test Session", starts_at: startsAt.toISOString() })
    .select("id")
    .single();
  if (sessionError) throw sessionError;
  const { error: attendanceError } = await admin
    .from("attendance_record")
    .insert({ person_id: personId, session_id: session.id, source: "manual_tick" });
  if (attendanceError) throw attendanceError;
  sessionIds.push(session.id);
  return session.id as string;
}

async function createApprovedChaseEmail(personId: string, sequenceNumber = 1) {
  const { data, error } = await admin
    .from("chase_email")
    .insert({
      person_id: personId,
      debt_cycle_started_at: new Date().toISOString(),
      sequence_number: sequenceNumber,
      status: "approved",
      subject: "test",
      body: "test",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

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

test.describe("sendChaseEmail", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: attendanceError } = await admin
      .from("attendance_record")
      .delete()
      .eq("person_id", personId);
    if (attendanceError) throw attendanceError;
    if (sessionIds.length > 0) {
      const { error: sessionError } = await admin.from("session").delete().in("id", sessionIds);
      if (sessionError) throw sessionError;
      sessionIds = [];
    }
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("sends when the person still has outstanding debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const chaseEmailId = await createApprovedChaseEmail(personId);

    const result = await sendChaseEmail(chaseEmailId, fakeAdapter());
    expect(result.sent).toBe(true);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, sent_at")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
  });

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

  test("cancels instead of sending when debt has already cleared", async () => {
    personId = await createPerson();
    // No attendance at all -- debt is 0.
    const chaseEmailId = await createApprovedChaseEmail(personId);

    const result = await sendChaseEmail(chaseEmailId);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("debt_cleared");

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, sent_at, note")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("cancelled");
    expect(row.sent_at).toBeNull();
    expect(row.note).toContain("Auto-cancelled");
  });

  test("processAutoSends only touches sequence_number > 1 approved rows", async () => {
    const originalFlag = process.env.CHASE_AUTO_SEND_REPEATS;
    process.env.CHASE_AUTO_SEND_REPEATS = "true";
    try {
      personId = await createPerson();
      await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
      await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
      const firstId = await createApprovedChaseEmail(personId, 1);
      const repeatId = await createApprovedChaseEmail(personId, 2);

      const result = await processAutoSends(fakeAdapter());
      expect(result.sent).toBeGreaterThanOrEqual(1);

      const { data: first, error: firstError } = await admin
        .from("chase_email")
        .select("status")
        .eq("id", firstId)
        .single();
      if (firstError) throw firstError;
      expect(first.status).toBe("approved"); // untouched -- sequence 1 is never auto-sent

      const { data: repeat, error: repeatError } = await admin
        .from("chase_email")
        .select("status")
        .eq("id", repeatId)
        .single();
      if (repeatError) throw repeatError;
      expect(repeat.status).toBe("sent");
    } finally {
      if (originalFlag === undefined) delete process.env.CHASE_AUTO_SEND_REPEATS;
      else process.env.CHASE_AUTO_SEND_REPEATS = originalFlag;
    }
  });

  test("processAutoSends does nothing when CHASE_AUTO_SEND_REPEATS is not set", async () => {
    const originalFlag = process.env.CHASE_AUTO_SEND_REPEATS;
    delete process.env.CHASE_AUTO_SEND_REPEATS;
    try {
      personId = await createPerson();
      await createAttendance(personId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
      await createAttendance(personId, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
      const repeatId = await createApprovedChaseEmail(personId, 2);

      const result = await processAutoSends();
      expect(result).toEqual({ sent: 0, cancelled: 0, failed: 0 });

      const { data: repeat, error } = await admin
        .from("chase_email")
        .select("status")
        .eq("id", repeatId)
        .single();
      if (error) throw error;
      expect(repeat.status).toBe("approved"); // untouched
    } finally {
      if (originalFlag === undefined) delete process.env.CHASE_AUTO_SEND_REPEATS;
      else process.env.CHASE_AUTO_SEND_REPEATS = originalFlag;
    }
  });

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
});
