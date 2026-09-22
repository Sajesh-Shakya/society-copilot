import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listRecentSessions } from "@/lib/attendance/queries";

const admin = createAdminClient();

async function createSession(title: string, startsAt: Date) {
  const { data, error } = await admin
    .from("session")
    .insert({ title, starts_at: startsAt.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createPerson() {
  const { data, error } = await admin
    .from("person")
    .insert({
      full_name: "Session List Test Person",
      email: `session-list-test-${crypto.randomUUID()}@example.test`,
      is_exempt: false,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("listRecentSessions", () => {
  let sessionIds: string[] = [];
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length > 0) {
      const { error: attendanceError } = await admin
        .from("attendance_record")
        .delete()
        .in("session_id", sessionIds);
      if (attendanceError) throw attendanceError;
      const { error: sessionError } = await admin.from("session").delete().in("id", sessionIds);
      if (sessionError) throw sessionError;
      sessionIds = [];
    }
    if (personIds.length > 0) {
      const { error: personError } = await admin.from("person").delete().in("id", personIds);
      if (personError) throw personError;
      personIds = [];
    }
  });

  test("includes a session from today and marks it isToday", async () => {
    const id = await createSession("Today's Test Session", new Date());
    sessionIds.push(id);

    const results = await listRecentSessions();
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.isToday).toBe(true);
  });

  test("includes a session from 10 days ago and marks it not isToday", async () => {
    const id = await createSession(
      "Ten Days Ago Test Session",
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions();
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.isToday).toBe(false);
  });

  test("excludes a session from 40 days ago", async () => {
    const id = await createSession(
      "Forty Days Ago Test Session",
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions();
    expect(results.some((r) => r.id === id)).toBe(false);
  });

  test("includes a future-dated session", async () => {
    const id = await createSession(
      "Future Test Session",
      new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions();
    expect(results.some((r) => r.id === id)).toBe(true);
  });

  test("reports the correct attendee count, excluding un-ticked attendance", async () => {
    const sessionId = await createSession("Attendee Count Test Session", new Date());
    sessionIds.push(sessionId);
    const attendedPersonId = await createPerson();
    const notAttendedPersonId = await createPerson();
    personIds.push(attendedPersonId, notAttendedPersonId);

    const { error: attendedError } = await admin
      .from("attendance_record")
      .insert({ person_id: attendedPersonId, session_id: sessionId, source: "manual_tick", attended: true });
    if (attendedError) throw attendedError;
    const { error: notAttendedError } = await admin
      .from("attendance_record")
      .insert({ person_id: notAttendedPersonId, session_id: sessionId, source: "manual_tick", attended: false });
    if (notAttendedError) throw notAttendedError;

    const results = await listRecentSessions();
    const found = results.find((r) => r.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.attendeeCount).toBe(1);
  });

  test("orders by startsAt descending (nearest-to-now first)", async () => {
    const olderId = await createSession(
      "Older Test Session",
      new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    );
    const newerId = await createSession("Newer Test Session", new Date());
    sessionIds.push(olderId, newerId);

    const results = await listRecentSessions();
    const olderIndex = results.findIndex((r) => r.id === olderId);
    const newerIndex = results.findIndex((r) => r.id === newerId);
    expect(newerIndex).toBeLessThan(olderIndex);
  });
});
