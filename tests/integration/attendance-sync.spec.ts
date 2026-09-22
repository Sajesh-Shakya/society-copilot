import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  syncSessionAttendance,
  SessionNotBoundError,
  SyncDebouncedError,
} from "@/lib/attendance/sync";
import type { Attendee, SignupDetail } from "@/lib/eactivities/types";
import { POST as syncRoutePost } from "@/app/api/sessions/[sessionId]/sync/route";

const admin = createAdminClient();

function fakeProvider(attendees: Attendee[]) {
  let calls = 0;
  return {
    calls: () => calls,
    getSignup: async (): Promise<SignupDetail> => {
      calls += 1;
      return {
        ID: "signup-1",
        Title: "Test Signup",
        Description: "",
        SignupOpen: new Date().toISOString(),
        SignupClose: new Date().toISOString(),
        AttendeesCount: attendees.length,
        MaximumAttendees: 100,
        Attendees: attendees,
      };
    },
  };
}

async function createSession(eactivitiesSignupId: string | null, lastSyncedAt: string | null = null) {
  const { data, error } = await admin
    .from("session")
    .insert({
      title: "Attendance Sync Test Session",
      starts_at: new Date().toISOString(),
      eactivities_signup_id: eactivitiesSignupId,
      last_synced_at: lastSyncedAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("syncSessionAttendance", () => {
  let sessionIds: string[] = [];
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length > 0) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (personIds.length > 0) {
      await admin.from("person").delete().in("id", personIds);
      personIds = [];
    }
  });

  test("throws SessionNotBoundError when the session has no eactivities_signup_id", async () => {
    const sessionId = await createSession(null);
    sessionIds.push(sessionId);

    const provider = fakeProvider([]);
    await expect(syncSessionAttendance(sessionId, { provider })).rejects.toThrow(
      SessionNotBoundError
    );
    expect(provider.calls()).toBe(0);
  });

  test("rejects a second sync within the 60s debounce window without calling eActivities", async () => {
    const sessionId = await createSession(`debounce-${crypto.randomUUID()}`, new Date().toISOString());
    sessionIds.push(sessionId);

    const provider = fakeProvider([]);
    await expect(syncSessionAttendance(sessionId, { provider })).rejects.toThrow(
      SyncDebouncedError
    );
    expect(provider.calls()).toBe(0);
  });

  test("creates a person and attendance record for a new attendee, matched by CID on a re-sync", async () => {
    const cid = `sync-cid-${crypto.randomUUID().slice(0, 8)}`;
    const email = `attendance-sync-test-${crypto.randomUUID()}@example.test`;
    const sessionId = await createSession(`signup-${crypto.randomUUID()}`);
    sessionIds.push(sessionId);

    const attendee: Attendee = {
      FirstName: "Sync",
      Surname: "Test",
      CID: cid,
      Email: email,
      Login: null,
    };
    const provider = fakeProvider([attendee]);

    const first = await syncSessionAttendance(sessionId, { provider });
    expect(first.attendeesSeen).toBe(1);
    expect(first.personsCreated).toBe(1);
    expect(first.attendanceRecordsCreated).toBe(1);

    const { data: created } = await admin
      .from("person")
      .select("id")
      .eq("cid", cid)
      .single();
    expect(created).toBeTruthy();
    personIds.push(created!.id);

    // Clear the debounce window set by the first call so the second call
    // actually reaches the (fake) provider again, rather than short-circuiting.
    await admin.from("session").update({ last_synced_at: null }).eq("id", sessionId);

    // Re-running against the *same* unchanged attendee list must not create
    // a second person (CID match) or a second attendance_record (idempotent
    // upsert, ON CONFLICT DO NOTHING) — task 2.2's verify item.
    const second = await syncSessionAttendance(sessionId, { provider });
    expect(second.attendeesSeen).toBe(1);
    expect(second.personsCreated).toBe(0);
    expect(second.attendanceRecordsCreated).toBe(0);
    expect(provider.calls()).toBe(2);

    const { count: personCount } = await admin
      .from("person")
      .select("id", { count: "exact", head: true })
      .eq("cid", cid);
    expect(personCount).toBe(1);

    const { count: attendanceCount } = await admin
      .from("attendance_record")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("person_id", created!.id);
    expect(attendanceCount).toBe(1);
  });

  test("matches an existing person by email when the attendee has no CID", async () => {
    const email = `attendance-sync-email-${crypto.randomUUID()}@example.test`;
    const { data: existing, error } = await admin
      .from("person")
      .insert({ full_name: "Existing Person", email, cid: null })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(existing.id);

    const sessionId = await createSession(`signup-${crypto.randomUUID()}`);
    sessionIds.push(sessionId);

    const provider = fakeProvider([
      { FirstName: "Existing", Surname: "Person", CID: null, Email: email, Login: null },
    ]);

    const result = await syncSessionAttendance(sessionId, { provider });
    expect(result.personsCreated).toBe(0);
    expect(result.attendanceRecordsCreated).toBe(1);

    const { count: personCount } = await admin
      .from("person")
      .select("id", { count: "exact", head: true })
      .ilike("email", email);
    expect(personCount).toBe(1);
  });
});

test.describe("POST /api/sessions/[sessionId]/sync", () => {
  const originalSecret = process.env.SYNC_TRIGGER_SECRET;

  test.afterEach(() => {
    if (originalSecret === undefined) delete process.env.SYNC_TRIGGER_SECRET;
    else process.env.SYNC_TRIGGER_SECRET = originalSecret;
  });

  test("rejects a request with a missing/wrong bearer token with 401, never reaching sync logic", async () => {
    process.env.SYNC_TRIGGER_SECRET = "correct-secret";

    const request = new Request("http://localhost/api/sessions/does-not-matter/sync", {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret" },
    });
    const response = await syncRoutePost(request, {
      params: Promise.resolve({ sessionId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(response.status).toBe(401);
  });

  test("rejects a request with no SYNC_TRIGGER_SECRET configured with 401", async () => {
    delete process.env.SYNC_TRIGGER_SECRET;

    const request = new Request("http://localhost/api/sessions/does-not-matter/sync", {
      method: "POST",
    });
    const response = await syncRoutePost(request, {
      params: Promise.resolve({ sessionId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(response.status).toBe(401);
  });
});
