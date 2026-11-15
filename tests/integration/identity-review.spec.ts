import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { applyCidEvidence } from "@/lib/identity/apply-cid-evidence";
import type { CidSource } from "@/lib/identity/cid-rule";
import {
  countOpenConflicts,
  listIncompleteNames,
  listOpenConflicts,
  listRecentOverwrites,
  listSameNameGroups,
} from "@/lib/identity/review-queries";
import {
  CID_TAKEN,
  dismissSameNameGroup,
  keepCurrent,
  takeCidFromHolder,
  useIncoming,
} from "@/lib/identity/resolve";

// Exercises the review queries and the resolve writers (the logic behind the
// people-review Server Actions, minus requireAdmin()). The judo club holds
// real data: every CID here is run-unique and non-numeric, every name is a
// made-up run-unique string, and query results are filtered to our rows.
const admin = createAdminClient();
const ADMIN_EMAIL = "review-tester@example.test";
const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let judoClubId: string;
let taekwondoClubId: string;
let personIds: string[] = [];
let sessionIds: string[] = [];
let productIds: string[] = [];
let purchaseIds: string[] = [];
let dismissalNameKeys: string[] = [];
let n = 0;

function testCid(tag: string): string {
  return `T${runId}${tag}`;
}

/** A made-up, run-unique two-word name so it can never match a real member. */
function uniqueName(tag: string): string {
  return `Zqreview ${runId}${tag}`;
}

async function insertPerson(fields: {
  clubId?: string;
  fullName?: string;
  cid?: string | null;
  cidSource?: CidSource | null;
}): Promise<string> {
  n += 1;
  const { data, error } = await admin
    .from("person")
    .insert({
      club_id: fields.clubId ?? judoClubId,
      email: `identity-review-${runId}-${n}@example.test`,
      full_name: fields.fullName ?? uniqueName(`p${n}`),
      cid: fields.cid ?? null,
      cid_source: fields.cidSource ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  personIds.push(data.id);
  return data.id as string;
}

async function insertAttendance(personId: string, startsAt: string): Promise<void> {
  const { data: session, error } = await admin
    .from("session")
    .insert({ club_id: judoClubId, title: "Identity Review Test Session", starts_at: startsAt })
    .select("id")
    .single();
  if (error) throw error;
  sessionIds.push(session.id);
  const { error: attendanceError } = await admin
    .from("attendance_record")
    .insert({ club_id: judoClubId, person_id: personId, session_id: session.id, source: "manual_tick" });
  if (attendanceError) throw attendanceError;
}

async function insertPurchase(personId: string): Promise<void> {
  if (productIds.length === 0) {
    const { data, error } = await admin
      .from("product")
      .insert({ club_id: judoClubId, name: `Review Test Pass ${runId}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (error) throw error;
    productIds.push(data.id);
  }
  const { data, error } = await admin
    .from("purchase")
    .insert({
      club_id: judoClubId,
      product_id: productIds[0],
      person_id: personId,
      source: "xlsx_upload",
      source_row_id: `identity-review-${randomUUID()}`,
      raw_person_name: "Review Purchase",
      raw_member_type: "Student",
      match_status: "manual_matched",
      purchased_at: "2026-02-01T00:00:00.000Z",
    })
    .select("id")
    .single();
  if (error) throw error;
  purchaseIds.push(data.id);
}

async function getPerson(id: string) {
  const { data, error } = await admin.from("person").select("cid, cid_source").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function conflictsFor(personId: string) {
  const { data, error } = await admin
    .from("person_identity_conflict")
    .select("id, outcome, status, existing_cid, incoming_cid, incoming_source, other_person_id, resolved_by, resolved_at")
    .eq("person_id", personId)
    .order("created_at");
  if (error) throw error;
  return data;
}

/** Person with `cid` (sso) that receives a disagreeing `incoming` claim, producing one open flag. */
async function flagged(
  incoming: string,
  incomingSource: CidSource = "sso",
  clubId = judoClubId,
): Promise<{ personId: string; conflictId: string; existing: string }> {
  const existing = testCid(`e${n + 1}`);
  const personId = await insertPerson({ clubId, cid: existing, cidSource: incomingSource });
  const result = await applyCidEvidence(createClubScopedClient(clubId), personId, incoming, incomingSource);
  expect(result.decision).toBe("flag");
  const rows = await conflictsFor(personId);
  expect(rows).toHaveLength(1);
  return { personId, conflictId: rows[0].id as string, existing };
}

test.beforeAll(async () => {
  const { data: judo, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = judo.id;
  const { data: tkd, error: tkdError } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  if (tkdError) throw tkdError;
  taekwondoClubId = tkd.id;
});

test.afterEach(async () => {
  if (sessionIds.length > 0) {
    await admin.from("attendance_record").delete().in("session_id", sessionIds);
    await admin.from("session").delete().in("id", sessionIds);
    sessionIds = [];
  }
  if (purchaseIds.length > 0) {
    const { error } = await admin.from("purchase").delete().in("id", purchaseIds);
    if (error) throw new Error(`Cleanup failed deleting purchase: ${error.message}`);
    purchaseIds = [];
  }
  if (productIds.length > 0) {
    await admin.from("product").delete().in("id", productIds);
    productIds = [];
  }
  if (dismissalNameKeys.length > 0) {
    await admin.from("person_duplicate_dismissal").delete().in("name_key", dismissalNameKeys);
    dismissalNameKeys = [];
  }
  if (personIds.length > 0) {
    await admin.from("person_identity_conflict").delete().in("person_id", personIds);
    await admin.from("person_identity_conflict").delete().in("other_person_id", personIds);
    const { error } = await admin.from("person").delete().in("id", personIds);
    if (error) throw new Error(`Cleanup failed deleting person: ${error.message}`);
    personIds = [];
  }
});

test.describe("open conflicts", () => {
  test("an open flag shows in listOpenConflicts and countOpenConflicts", async () => {
    const before = await countOpenConflicts(judoClubId);
    const incoming = testCid("in1");
    const { personId, conflictId, existing } = await flagged(incoming);

    expect(await countOpenConflicts(judoClubId)).toBe(before + 1);
    const listed = (await listOpenConflicts(judoClubId)).find((c) => c.id === conflictId);
    expect(listed).toMatchObject({
      personId,
      currentCid: existing,
      currentSource: "sso",
      incomingCid: incoming,
      incomingSource: "sso",
      canUseIncoming: true,
      canTake: false,
    });
    expect(listed?.personName).toMatch(/^Zqreview /);
    expect(listed?.personEmail).toMatch(/@example\.test$/);
  });

  test("keepCurrent dismisses, and a repeat of the same disagreement creates no new row", async () => {
    const incoming = testCid("in2");
    const { personId, conflictId, existing } = await flagged(incoming);

    await keepCurrent(judoClubId, conflictId, ADMIN_EMAIL);
    let rows = await conflictsFor(personId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "dismissed", resolved_by: ADMIN_EMAIL });
    expect(rows[0].resolved_at).not.toBeNull();
    expect((await listOpenConflicts(judoClubId)).some((c) => c.id === conflictId)).toBe(false);

    await applyCidEvidence(createClubScopedClient(judoClubId), personId, incoming, "sso");
    rows = await conflictsFor(personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("dismissed");
    expect((await getPerson(personId)).cid).toBe(existing);
  });

  test("useIncoming applies a free CID and resolves the conflict", async () => {
    const incoming = testCid("in3");
    const { personId, conflictId } = await flagged(incoming);

    await useIncoming(judoClubId, conflictId, ADMIN_EMAIL);
    expect(await getPerson(personId)).toEqual({ cid: incoming, cid_source: "sso" });
    const [row] = await conflictsFor(personId);
    expect(row).toMatchObject({ status: "resolved", resolved_by: ADMIN_EMAIL });
    expect(row.resolved_at).not.toBeNull();
  });

  test("useIncoming refuses when the incoming CID is now held by someone else", async () => {
    const incoming = testCid("in4");
    const { personId, conflictId, existing } = await flagged(incoming);
    await insertPerson({ cid: incoming, cidSource: "walk_in" });

    await expect(useIncoming(judoClubId, conflictId, ADMIN_EMAIL)).rejects.toThrow(CID_TAKEN);
    expect((await getPerson(personId)).cid).toBe(existing);
    expect((await conflictsFor(personId))[0].status).toBe("open");
  });

  test("takeCidFromHolder moves the CID from a walk_in holder for sso evidence", async () => {
    const incoming = testCid("in5");
    const holderId = await insertPerson({ cid: incoming, cidSource: "walk_in" });
    const { personId, conflictId } = await flagged(incoming, "sso");
    const listed = (await listOpenConflicts(judoClubId)).find((c) => c.id === conflictId);
    expect(listed).toMatchObject({ otherPersonId: holderId, canTake: true, canUseIncoming: false });

    await takeCidFromHolder(judoClubId, conflictId, ADMIN_EMAIL);

    expect(await getPerson(holderId)).toEqual({ cid: null, cid_source: null });
    expect(await getPerson(personId)).toEqual({ cid: incoming, cid_source: "sso" });
    const [original] = await conflictsFor(personId);
    expect(original).toMatchObject({ status: "resolved", resolved_by: ADMIN_EMAIL });
    const holderRows = await conflictsFor(holderId);
    expect(holderRows).toHaveLength(1);
    expect(holderRows[0]).toMatchObject({
      outcome: "overwritten",
      status: "resolved",
      existing_cid: incoming,
      other_person_id: personId,
    });
    const overwrites = await listRecentOverwrites(judoClubId);
    expect(overwrites.some((o) => o.personId === holderId)).toBe(true);
  });

  test("takeCidFromHolder refuses when the holder is equal or higher rank", async () => {
    const incoming = testCid("in6");
    const holderId = await insertPerson({ cid: incoming, cidSource: "sso" });
    const { personId, conflictId, existing } = await flagged(incoming, "sso");

    await expect(takeCidFromHolder(judoClubId, conflictId, ADMIN_EMAIL)).rejects.toThrow();
    expect((await getPerson(holderId)).cid).toBe(incoming);
    expect((await getPerson(personId)).cid).toBe(existing);
    expect((await conflictsFor(personId))[0].status).toBe("open");
    expect(await conflictsFor(holderId)).toHaveLength(0);

    const purchaseIncoming = testCid("in7");
    const higherHolder = await insertPerson({ cid: purchaseIncoming, cidSource: "sso" });
    const p = await flagged(purchaseIncoming, "purchase");
    await expect(takeCidFromHolder(judoClubId, p.conflictId, ADMIN_EMAIL)).rejects.toThrow();
    expect((await getPerson(higherHolder)).cid).toBe(purchaseIncoming);
  });

  test("all conflict writers refuse a conflict from another club", async () => {
    const incoming = testCid("in8");
    const { personId, conflictId } = await flagged(incoming, "sso", taekwondoClubId);

    await expect(keepCurrent(judoClubId, conflictId, ADMIN_EMAIL)).rejects.toThrow();
    await expect(useIncoming(judoClubId, conflictId, ADMIN_EMAIL)).rejects.toThrow();
    await expect(takeCidFromHolder(judoClubId, conflictId, ADMIN_EMAIL)).rejects.toThrow();
    expect((await conflictsFor(personId))[0].status).toBe("open");
    expect((await listOpenConflicts(judoClubId)).some((c) => c.id === conflictId)).toBe(false);
  });
});

test.describe("same-name groups and incomplete names", () => {
  test("a group of 2 appears with counts, hides after dismissal, reappears when a third joins", async () => {
    const name = uniqueName("group");
    const nameKey = name.trim().toLowerCase();
    dismissalNameKeys.push(nameKey);
    const a = await insertPerson({ fullName: name, cid: testCid("ga"), cidSource: "sso" });
    const b = await insertPerson({ fullName: `  ${name.toUpperCase()} ` });
    await insertAttendance(a, "2026-01-01T18:00:00.000Z");
    await insertAttendance(a, "2026-01-08T18:00:00.000Z");
    await insertPurchase(b);

    const find = async () => (await listSameNameGroups(judoClubId)).find((g) => g.nameKey === nameKey);
    const group = await find();
    expect(group).toBeDefined();
    expect(group!.people.map((p) => p.id).sort()).toEqual([a, b].sort());
    expect(group!.people.find((p) => p.id === a)).toMatchObject({
      cid: testCid("ga"),
      cidSource: "sso",
      attendanceCount: 2,
      purchaseCount: 0,
    });
    expect(group!.people.find((p) => p.id === b)).toMatchObject({ attendanceCount: 0, purchaseCount: 1 });

    await dismissSameNameGroup(judoClubId, group!.nameKey, group!.membersHash, ADMIN_EMAIL);
    // Idempotent.
    await dismissSameNameGroup(judoClubId, group!.nameKey, group!.membersHash, ADMIN_EMAIL);
    expect(await find()).toBeUndefined();

    const c = await insertPerson({ fullName: name });
    const regrouped = await find();
    expect(regrouped?.people.map((p) => p.id).sort()).toEqual([a, b, c].sort());
    expect(regrouped?.membersHash).not.toBe(group!.membersHash);
  });

  test("one-word names are listed as incomplete", async () => {
    const oneWord = `Zqreview${runId}`;
    const id = await insertPerson({ fullName: oneWord });
    await insertPerson({ fullName: uniqueName("full") });

    const incomplete = await listIncompleteNames(judoClubId);
    expect(incomplete.find((p) => p.id === id)).toMatchObject({ fullName: oneWord });
    expect(incomplete.every((p) => !p.fullName.trim().includes(" "))).toBe(true);
  });
});
