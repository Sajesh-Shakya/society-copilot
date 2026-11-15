import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncSessionAttendance } from "@/lib/attendance/sync";
import type { Attendee, SignupDetail } from "@/lib/eactivities/types";

// Live eActivities sync applies CID evidence with source `sso`. Uses the
// test-only options.provider injection, same as attendance-sync.spec.ts.
const admin = createAdminClient();

let judoClubId: string;
let sessionIds: string[] = [];
let personIds: string[] = [];

function fakeProvider(attendees: Attendee[]) {
  return {
    getSignup: async (): Promise<SignupDetail> => ({
      ID: "signup-1",
      Title: "Test Signup",
      Description: "",
      SignupOpen: new Date().toISOString(),
      SignupClose: new Date().toISOString(),
      AttendeesCount: attendees.length,
      MaximumAttendees: 100,
      Attendees: attendees,
    }),
  };
}

/** 8 random digits starting 99, unlikely to clash with a real CID. */
function testCid(): string {
  return `99${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
}

function testEmail(): string {
  return `identity-sync-${crypto.randomUUID()}@example.test`;
}

async function createSession() {
  const { data, error } = await admin
    .from("session")
    .insert({
      club_id: judoClubId,
      title: "Identity Sync Test Session",
      starts_at: new Date().toISOString(),
      eactivities_signup_id: `signup-${crypto.randomUUID()}`,
    })
    .select("id")
    .single();
  if (error) throw error;
  sessionIds.push(data.id);
  return data.id as string;
}

async function insertPerson(fields: { email: string; cid: string | null; cid_source: string | null }) {
  const { data, error } = await admin
    .from("person")
    .insert({ club_id: judoClubId, full_name: "Sync Seed", ...fields })
    .select("id")
    .single();
  if (error) throw error;
  personIds.push(data.id);
  return data.id as string;
}

async function getPerson(id: string) {
  const { data, error } = await admin.from("person").select("cid, cid_source").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function conflictsFor(personId: string) {
  const { data, error } = await admin
    .from("person_identity_conflict")
    .select("outcome, status, existing_cid, incoming_cid, incoming_source")
    .eq("person_id", personId);
  if (error) throw error;
  return data;
}

function attendee(email: string, cid: string | null): Attendee {
  return { FirstName: "Sync", Surname: "Attendee", CID: cid, Email: email, Login: null };
}

test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});

test.afterEach(async () => {
  if (sessionIds.length > 0) {
    await admin.from("attendance_record").delete().in("session_id", sessionIds);
    await admin.from("session").delete().in("id", sessionIds);
    sessionIds = [];
  }
  if (personIds.length > 0) {
    await admin.from("person_identity_conflict").delete().in("person_id", personIds);
    await admin.from("person_identity_conflict").delete().in("other_person_id", personIds);
    await admin.from("person").delete().in("id", personIds);
    personIds = [];
  }
});

test.describe("syncSessionAttendance CID evidence", () => {
  test("email match on a walk_in person with a wrong CID overwrites it; email match on an sso person flags; a re-run adds nothing", async () => {
    const walkInEmail = testEmail();
    const walkInWrongCid = testCid();
    const walkInRightCid = testCid();
    const walkInPersonId = await insertPerson({ email: walkInEmail, cid: walkInWrongCid, cid_source: "walk_in" });

    const ssoEmail = testEmail();
    const ssoCid = testCid();
    const ssoOtherCid = testCid();
    const ssoPersonId = await insertPerson({ email: ssoEmail, cid: ssoCid, cid_source: "sso" });

    const sessionId = await createSession();
    const provider = fakeProvider([attendee(walkInEmail, walkInRightCid), attendee(ssoEmail, ssoOtherCid)]);

    const first = await syncSessionAttendance(sessionId, judoClubId, { provider });
    expect(first.personsCreated).toBe(0);

    const overwritten = await getPerson(walkInPersonId);
    expect(overwritten).toEqual({ cid: walkInRightCid, cid_source: "sso" });
    const walkInConflicts = await conflictsFor(walkInPersonId);
    expect(walkInConflicts).toHaveLength(1);
    expect(walkInConflicts[0]).toMatchObject({
      outcome: "overwritten",
      existing_cid: walkInWrongCid,
      incoming_cid: walkInRightCid,
      incoming_source: "sso",
    });

    const kept = await getPerson(ssoPersonId);
    expect(kept).toEqual({ cid: ssoCid, cid_source: "sso" });
    const ssoConflicts = await conflictsFor(ssoPersonId);
    expect(ssoConflicts).toHaveLength(1);
    expect(ssoConflicts[0]).toMatchObject({
      outcome: "flagged",
      status: "open",
      existing_cid: ssoCid,
      incoming_cid: ssoOtherCid,
      incoming_source: "sso",
    });

    await admin.from("session").update({ last_synced_at: null }).eq("id", sessionId);
    const second = await syncSessionAttendance(sessionId, judoClubId, { provider });
    expect(second.personsCreated).toBe(0);
    expect(second.attendanceRecordsCreated).toBe(0);
    expect(await conflictsFor(walkInPersonId)).toHaveLength(1);
    expect(await conflictsFor(ssoPersonId)).toHaveLength(1);
  });

  test("email match on a CID-less person sets the normalised CID with source sso", async () => {
    const email = testEmail();
    const personId = await insertPerson({ email, cid: null, cid_source: null });
    const cid8 = `09${testCid().slice(2)}`;
    const sessionId = await createSession();

    // Sent without the leading 0; the sync normalises before applying it.
    await syncSessionAttendance(sessionId, judoClubId, {
      provider: fakeProvider([attendee(email, cid8.slice(1))]),
    });

    expect(await getPerson(personId)).toEqual({ cid: cid8, cid_source: "sso" });
    expect(await conflictsFor(personId)).toHaveLength(0);
  });

  test("a new attendee with a CID is created with cid_source sso", async () => {
    const email = testEmail();
    const cid = testCid();
    const sessionId = await createSession();

    const result = await syncSessionAttendance(sessionId, judoClubId, {
      provider: fakeProvider([attendee(email, cid)]),
    });
    expect(result.personsCreated).toBe(1);

    const { data, error } = await admin
      .from("person")
      .select("id, cid, cid_source")
      .eq("club_id", judoClubId)
      .eq("cid", cid)
      .single();
    if (error) throw error;
    personIds.push(data.id);
    expect(data.cid_source).toBe("sso");
  });
});
