import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createWalkInForClub } from "@/lib/attendance/walk-in";
import { CID_ERROR, NAME_ERROR } from "@/lib/identity/walk-in-schema";

// Exercises createWalkInForClub (the logic behind the createWalkIn Server
// Action, minus requireAdmin(), which needs a real request context -- same
// split as attendance-toggle.spec.ts).
const admin = createAdminClient();

let judoClubId: string;
let sessionId: string;
let personIds: string[] = [];

/** 8 random digits starting 99, unlikely to clash with a real CID. */
function testCid(): string {
  return `99${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
}

function testEmail(): string {
  return `identity-walk-in-${crypto.randomUUID()}@example.test`;
}

async function insertPerson(fields: { email: string; cid: string | null; cid_source: string | null }) {
  const { data, error } = await admin
    .from("person")
    .insert({ club_id: judoClubId, full_name: "Walk In Seed", ...fields })
    .select("id")
    .single();
  if (error) throw error;
  personIds.push(data.id);
  return data.id as string;
}

async function getPerson(id: string) {
  const { data, error } = await admin
    .from("person")
    .select("id, cid, cid_source, identity_confidence, full_name")
    .eq("id", id)
    .single();
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

test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});

test.beforeEach(async () => {
  const { data, error } = await admin
    .from("session")
    .insert({ club_id: judoClubId, title: "Identity Walk-in Test Session", starts_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  sessionId = data.id;
});

test.afterEach(async () => {
  await admin.from("attendance_record").delete().eq("session_id", sessionId);
  await admin.from("session").delete().eq("id", sessionId);
  if (personIds.length > 0) {
    await admin.from("person_identity_conflict").delete().in("person_id", personIds);
    await admin.from("person_identity_conflict").delete().in("other_person_id", personIds);
    await admin.from("person").delete().in("id", personIds);
    personIds = [];
  }
});

test.describe("createWalkInForClub", () => {
  test("a 7-digit CID creates a provisional person with the normalised CID and source walk_in", async () => {
    // The brief's example CID 6113211 (-> 06113211) belongs to a real judo
    // member, so a random 7-digit CID stands in: the walk-in would otherwise
    // reuse that real person. Same normalisation path (7 digits -> leading 0).
    const sevenDigits = testCid().slice(1); // "9xxxxxx"
    const cid8 = `0${sevenDigits}`;
    const { data: clash } = await admin
      .from("person")
      .select("id")
      .eq("club_id", judoClubId)
      .eq("cid", cid8)
      .maybeSingle();
    expect(clash, `test CID ${cid8} already belongs to a judo person`).toBeNull();

    const result = await createWalkInForClub(judoClubId, {
      sessionId,
      email: testEmail(),
      fullName: "  Sean   Rawlins ",
      cid: sevenDigits,
    });
    if ("error" in result) throw new Error(result.error);
    personIds.push(result.personId);
    expect(result.reusedExisting).toBe(false);

    const person = await getPerson(result.personId);
    expect(person.cid).toBe(cid8);
    expect(person.cid_source).toBe("walk_in");
    expect(person.identity_confidence).toBe("provisional");
    expect(person.full_name).toBe("Sean Rawlins");

    const { count } = await admin
      .from("attendance_record")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("person_id", result.personId);
    expect(count).toBe(1);
  });

  test("a single-word name is rejected with the shared message and nothing is written", async () => {
    const email = testEmail();
    const result = await createWalkInForClub(judoClubId, { sessionId, email, fullName: "Sean", cid: testCid() });
    expect(result).toEqual({ error: NAME_ERROR });

    const { count } = await admin.from("person").select("id", { count: "exact", head: true }).eq("email", email);
    expect(count).toBe(0);
  });

  test("a malformed CID is rejected with the shared message and nothing is written", async () => {
    const email = testEmail();
    const result = await createWalkInForClub(judoClubId, {
      sessionId,
      email,
      fullName: "Sean Rawlins",
      cid: "0307902x",
    });
    expect(result).toEqual({ error: CID_ERROR });

    const { count } = await admin.from("person").select("id", { count: "exact", head: true }).eq("email", email);
    expect(count).toBe(0);
  });

  test("email of an sso person with a different CID leaves the CID alone and records one ignored conflict", async () => {
    const email = testEmail();
    const ssoCid = testCid();
    const typedCid = testCid();
    const personId = await insertPerson({ email, cid: ssoCid, cid_source: "sso" });

    const result = await createWalkInForClub(judoClubId, { sessionId, email, fullName: "Sean Rawlins", cid: typedCid });
    if ("error" in result) throw new Error(result.error);
    expect(result).toEqual({ personId, reusedExisting: true });

    const person = await getPerson(personId);
    expect(person.cid).toBe(ssoCid);
    expect(person.cid_source).toBe("sso");

    const conflicts = await conflictsFor(personId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      outcome: "ignored",
      existing_cid: ssoCid,
      incoming_cid: typedCid,
      incoming_source: "walk_in",
    });
  });

  test("email of a CID-less person fills the CID with source walk_in", async () => {
    const email = testEmail();
    const typedCid = testCid();
    const personId = await insertPerson({ email, cid: null, cid_source: null });

    const result = await createWalkInForClub(judoClubId, { sessionId, email, fullName: "Sean Rawlins", cid: typedCid });
    if ("error" in result) throw new Error(result.error);
    expect(result).toEqual({ personId, reusedExisting: true });

    const person = await getPerson(personId);
    expect(person.cid).toBe(typedCid);
    expect(person.cid_source).toBe("walk_in");
    expect(await conflictsFor(personId)).toHaveLength(0);
  });

  test("a CID owned by someone else reuses that person and records no conflict", async () => {
    const holderCid = testCid();
    const holderId = await insertPerson({ email: testEmail(), cid: holderCid, cid_source: "sso" });

    const result = await createWalkInForClub(judoClubId, {
      sessionId,
      email: testEmail(),
      fullName: "Sean Rawlins",
      cid: holderCid,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result).toEqual({ personId: holderId, reusedExisting: true });

    expect(await conflictsFor(holderId)).toHaveLength(0);
    const holder = await getPerson(holderId);
    expect(holder.cid).toBe(holderCid);
    expect(holder.cid_source).toBe("sso");
  });
});
