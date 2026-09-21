import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendChaseEmail, processAutoSends } from "@/lib/chase/send";

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

    const result = await sendChaseEmail(chaseEmailId);
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

      const result = await processAutoSends();
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
      expect(result).toEqual({ sent: 0, cancelled: 0 });

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
});
