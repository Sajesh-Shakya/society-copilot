import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listRecentSessions } from "@/lib/attendance/queries";

const admin = createAdminClient();

let judoClubId: string;
test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});

async function createSession(title: string, startsAt: Date) {
  const { data, error } = await admin
    .from("session")
    .insert({ club_id: judoClubId, title, starts_at: startsAt.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createPerson() {
  const { data, error } = await admin
    .from("person")
    .insert({
      club_id: judoClubId,
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

    const results = await listRecentSessions(judoClubId);
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

    const results = await listRecentSessions(judoClubId);
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

    const results = await listRecentSessions(judoClubId);
    expect(results.some((r) => r.id === id)).toBe(false);
  });

  test("includes a future-dated session and marks it isFuture", async () => {
    const id = await createSession(
      "Future Test Session",
      new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions(judoClubId);
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.isFuture).toBe(true);
  });

  test("marks a past session as not isFuture", async () => {
    const id = await createSession(
      "Past Test Session",
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    );
    sessionIds.push(id);

    const results = await listRecentSessions(judoClubId);
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.isFuture).toBe(false);
  });

  test("reports the correct attendee count, excluding un-ticked attendance", async () => {
    const sessionId = await createSession("Attendee Count Test Session", new Date());
    sessionIds.push(sessionId);
    const attendedPersonId = await createPerson();
    const notAttendedPersonId = await createPerson();
    personIds.push(attendedPersonId, notAttendedPersonId);

    const { error: attendedError } = await admin
      .from("attendance_record")
      .insert({ club_id: judoClubId, person_id: attendedPersonId, session_id: sessionId, source: "manual_tick", attended: true });
    if (attendedError) throw attendedError;
    const { error: notAttendedError } = await admin
      .from("attendance_record")
      .insert({ club_id: judoClubId, person_id: notAttendedPersonId, session_id: sessionId, source: "manual_tick", attended: false });
    if (notAttendedError) throw notAttendedError;

    const results = await listRecentSessions(judoClubId);
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

    const results = await listRecentSessions(judoClubId);
    const olderIndex = results.findIndex((r) => r.id === olderId);
    const newerIndex = results.findIndex((r) => r.id === newerId);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  test("a session cancelled less than 30 minutes ago still appears, marked cancelled", async () => {
    const id = await createSession("Recently Cancelled Test Session", new Date());
    sessionIds.push(id);
    const { error } = await admin
      .from("session")
      .update({ cancelled_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() })
      .eq("id", id);
    if (error) throw error;

    const results = await listRecentSessions(judoClubId);
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.cancelledAt).not.toBeNull();
  });

  test("a session cancelled more than 30 minutes ago drops off the list", async () => {
    const id = await createSession("Long-Cancelled Test Session", new Date());
    sessionIds.push(id);
    const { error } = await admin
      .from("session")
      .update({ cancelled_at: new Date(Date.now() - 31 * 60 * 1000).toISOString() })
      .eq("id", id);
    if (error) throw error;

    const results = await listRecentSessions(judoClubId);
    expect(results.find((r) => r.id === id)).toBeUndefined();
  });

  test("never includes a session from a different club", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const { data: tkdSession, error } = await admin
      .from("session")
      .insert({ club_id: taekwondo!.id, title: "Taekwondo Isolation Test Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw error;
    sessionIds.push(tkdSession!.id);

    const results = await listRecentSessions(judoClubId);
    expect(results.some((r) => r.id === tkdSession!.id)).toBe(false);
  });

  test("returns correct attendee counts when there are more than 100 sessions", async () => {
    const base = Date.now() + 365 * 24 * 60 * 60 * 1000; // far future, clear of other tests
    const { data: inserted, error } = await admin
      .from("session")
      .insert(
        Array.from({ length: 130 }, (_, i) => ({
          club_id: judoClubId,
          title: `Session List Bulk ${i}`,
          starts_at: new Date(base + i * 60 * 60 * 1000).toISOString(),
        }))
      )
      .select("id, starts_at");
    if (error) throw error;
    const ordered = inserted!.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    sessionIds.push(...ordered.map((s) => s.id));

    const p1 = await createPerson();
    const p2 = await createPerson();
    personIds.push(p1, p2);
    const mk = (sessionId: string, personId: string, attended: boolean) => ({
      club_id: judoClubId,
      session_id: sessionId,
      person_id: personId,
      attended,
      source: "manual_tick",
    });
    // Index 3 is in the first chunk of 100, index 120 in the second.
    const { error: recError } = await admin.from("attendance_record").insert([
      mk(ordered[3].id, p1, true),
      mk(ordered[3].id, p2, true),
      mk(ordered[120].id, p1, true),
      mk(ordered[120].id, p2, false),
    ]);
    if (recError) throw recError;

    const results = await listRecentSessions(judoClubId);
    const byId = new Map(results.map((r) => [r.id, r.attendeeCount]));
    expect(byId.get(ordered[3].id)).toBe(2);
    expect(byId.get(ordered[120].id)).toBe(1);
    expect(byId.get(ordered[0].id)).toBe(0);
    expect(byId.get(ordered[129].id)).toBe(0);
  });
});
