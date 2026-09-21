import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateChaseEmails } from "@/lib/chase/generator";

const admin = createAdminClient();
let sessionIds: string[] = [];

async function createPerson(overrides: { isExempt?: boolean } = {}) {
  const email = `chase-gen-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({
      full_name: "Chase Gen Test Person",
      email,
      is_exempt: overrides.isExempt ?? false,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createAttendance(personId: string, startsAt: Date) {
  const { data: session, error: sessionError } = await admin
    .from("session")
    .insert({ title: "Chase Gen Test Session", starts_at: startsAt.toISOString() })
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

test.describe("generateChaseEmails", () => {
  // generateChaseEmails() processes ALL active debt cycles in a single
  // pass (unlike getOutstandingDebt/applyWaivers, which are scoped to one
  // person/purchase), so concurrent invocations would race on the same
  // chase_email inserts. playwright.integration.config.ts now runs the
  // whole integration suite with workers: 1, which already prevents this;
  // this serial mode is kept as defense-in-depth documentation of the
  // requirement, not a substitute for it.
  test.describe.configure({ mode: "serial" });

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

  test("a person with 2 unpaid sessions, the older past the 7-day threshold, gets a sequence-1 draft", async () => {
    personId = await createPerson();
    const now = new Date();
    // Free trial (excluded from debt) -- push it further back so it's
    // unambiguously the earliest attendance ever.
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    // This is the oldest DEBT-counting session -- 10 days ago, past the
    // 7-day default threshold.
    await createAttendance(personId, new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));

    const result = await generateChaseEmails();
    expect(result.created).toBeGreaterThanOrEqual(1);

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("sequence_number, status, subject, body")
      .eq("person_id", personId);
    if (error) throw error;

    expect(rows).toHaveLength(1);
    expect(rows![0].sequence_number).toBe(1);
    expect(rows![0].status).toBe("pending_approval");
    expect(rows![0].subject).toContain("1 unpaid session");
  });

  test("running generateChaseEmails twice in a row does not create a duplicate draft", async () => {
    personId = await createPerson();
    const now = new Date();
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));

    await generateChaseEmails();
    await generateChaseEmails();

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("id")
      .eq("person_id", personId);
    if (error) throw error;
    expect(rows).toHaveLength(1);
  });

  test("a person with debt younger than the threshold gets no draft", async () => {
    personId = await createPerson();
    const now = new Date();
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    // Only 2 days old -- under the 7-day threshold.
    await createAttendance(personId, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));

    await generateChaseEmails();

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("id")
      .eq("person_id", personId);
    if (error) throw error;
    expect(rows).toHaveLength(0);
  });

  test("an exempt person with old debt gets no draft (DC-5)", async () => {
    personId = await createPerson({ isExempt: true });
    const now = new Date();
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));

    await generateChaseEmails();

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("id")
      .eq("person_id", personId);
    if (error) throw error;
    expect(rows).toHaveLength(0);
  });

  test("a repeat reminder drafts as pending_approval once 7+ days have passed since the last one was sent", async () => {
    personId = await createPerson();
    const now = new Date();
    await createAttendance(personId, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
    await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));

    const { error: insertError } = await admin.from("chase_email").insert({
      person_id: personId,
      debt_cycle_started_at: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString(),
      sequence_number: 1,
      status: "sent",
      sent_at: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      subject: "prior chase",
      body: "prior chase",
    });
    if (insertError) throw insertError;

    const result = await generateChaseEmails();
    expect(result.created).toBe(1);

    const { data: rows, error } = await admin
      .from("chase_email")
      .select("sequence_number, status")
      .eq("person_id", personId)
      .order("sequence_number", { ascending: true });
    if (error) throw error;

    expect(rows).toHaveLength(2);
    expect(rows![1].sequence_number).toBe(2);
    expect(rows![1].status).toBe("pending_approval");
  });

  test("a repeat reminder pre-approves when CHASE_AUTO_SEND_REPEATS is true", async () => {
    const originalFlag = process.env.CHASE_AUTO_SEND_REPEATS;
    process.env.CHASE_AUTO_SEND_REPEATS = "true";
    try {
      personId = await createPerson();
      const now = new Date();
      await createAttendance(personId, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
      await createAttendance(personId, new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000));

      const { error: insertError } = await admin.from("chase_email").insert({
        person_id: personId,
        debt_cycle_started_at: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        sequence_number: 1,
        status: "sent",
        sent_at: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        subject: "prior chase",
        body: "prior chase",
      });
      if (insertError) throw insertError;

      await generateChaseEmails();

      const { data: rows, error } = await admin
        .from("chase_email")
        .select("sequence_number, status")
        .eq("person_id", personId)
        .eq("sequence_number", 2);
      if (error) throw error;
      expect(rows).toHaveLength(1);
      expect(rows![0].status).toBe("approved");
    } finally {
      if (originalFlag === undefined) delete process.env.CHASE_AUTO_SEND_REPEATS;
      else process.env.CHASE_AUTO_SEND_REPEATS = originalFlag;
    }
  });
});
