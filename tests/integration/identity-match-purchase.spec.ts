import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import { rematchUnmatchedPurchases } from "@/lib/purchase/interface";
import { matchPurchaseToPerson } from "@/lib/identity/match-purchase";
import { suggestPersonsForPurchase } from "@/lib/identity/suggestions";

// Exercises matchPurchaseToPerson / suggestPersonsForPurchase (the logic
// behind the identity Server Actions, minus requireAdmin(), which needs a
// real request context -- same split as identity-walk-in.spec.ts).
const admin = createAdminClient();
const ADMIN_EMAIL = "match-tester@example.test";

let judoClubId: string;
let taekwondoClubId: string;
let personIds: string[] = [];
let purchaseIds: string[] = [];
let productIds: string[] = [];
let sessionIds: string[] = [];

/** 8 random digits starting 99, unlikely to clash with a real CID. */
function testCid(): string {
  return `99${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
}

function testEmail(): string {
  return `identity-match-${randomUUID()}@example.test`;
}

async function insertPerson(fields: {
  clubId?: string;
  email?: string;
  fullName?: string;
  cid?: string | null;
  cidSource?: string | null;
}): Promise<string> {
  const { data, error } = await admin
    .from("person")
    .insert({
      club_id: fields.clubId ?? judoClubId,
      email: fields.email ?? testEmail(),
      full_name: fields.fullName ?? `Match Seed ${randomUUID()}`,
      cid: fields.cid ?? null,
      cid_source: fields.cidSource ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  personIds.push(data.id);
  return data.id as string;
}

async function insertProduct(clubId = judoClubId): Promise<string> {
  const { data, error } = await admin
    .from("product")
    .insert({ club_id: clubId, name: `Match Test Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
    .select("id")
    .single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id as string;
}

async function insertPurchase(fields: {
  clubId?: string;
  productId: string;
  rawName?: string;
  rawEmail?: string | null;
  rawCid?: string | null;
  memberType?: string;
  personId?: string | null;
  matchStatus?: string;
}): Promise<string> {
  const { data, error } = await admin
    .from("purchase")
    .insert({
      club_id: fields.clubId ?? judoClubId,
      product_id: fields.productId,
      person_id: fields.personId ?? null,
      source: "xlsx_upload",
      source_row_id: `identity-match-${randomUUID()}`,
      raw_person_name: fields.rawName ?? `Nobody ${randomUUID()}`,
      raw_email: fields.rawEmail ?? null,
      raw_cid: fields.rawCid ?? null,
      raw_member_type: fields.memberType ?? "Student",
      match_status: fields.matchStatus ?? "unmatched",
      purchased_at: "2026-02-01T00:00:00.000Z",
    })
    .select("id")
    .single();
  if (error) throw error;
  purchaseIds.push(data.id);
  return data.id as string;
}

async function insertAttendance(personId: string, startsAt: string): Promise<void> {
  const { data: session, error } = await admin
    .from("session")
    .insert({ club_id: judoClubId, title: "Identity Match Test Session", starts_at: startsAt })
    .select("id")
    .single();
  if (error) throw error;
  sessionIds.push(session.id);
  const { error: attendanceError } = await admin
    .from("attendance_record")
    .insert({ club_id: judoClubId, person_id: personId, session_id: session.id, source: "manual_tick" });
  if (attendanceError) throw attendanceError;
}

async function getPurchase(id: string) {
  const { data, error } = await admin
    .from("purchase")
    .select("person_id, match_status, manual_matched_by, manual_matched_at")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function getPerson(id: string) {
  const { data, error } = await admin.from("person").select("cid, cid_source, is_student").eq("id", id).single();
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
  if (personIds.length > 0) {
    await admin.from("person_identity_conflict").delete().in("person_id", personIds);
    await admin.from("person_identity_conflict").delete().in("other_person_id", personIds);
    const { error } = await admin.from("person").delete().in("id", personIds);
    if (error) throw new Error(`Cleanup failed deleting person: ${error.message}`);
    personIds = [];
  }
});

test.describe("matchPurchaseToPerson", () => {
  test("matches an unmatched purchase: manual_matched, audit columns, is_student, waiver applied", async () => {
    const personId = await insertPerson({});
    await insertAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial, never debt
    await insertAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1
    expect(await getOutstandingDebt(personId)).toBe(1);

    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, memberType: "Student" });

    const before = Date.now();
    const result = await matchPurchaseToPerson(judoClubId, purchaseId, personId, { adoptCid: false }, ADMIN_EMAIL);
    expect(result).toEqual({ matched: true, cid: { decision: "none" } });

    const purchase = await getPurchase(purchaseId);
    expect(purchase.person_id).toBe(personId);
    expect(purchase.match_status).toBe("manual_matched");
    expect(purchase.manual_matched_by).toBe(ADMIN_EMAIL);
    expect(new Date(purchase.manual_matched_at!).getTime()).toBeGreaterThanOrEqual(before - 60_000);

    expect((await getPerson(personId)).is_student).toBe(true);
    expect(await getOutstandingDebt(personId)).toBe(0);
  });

  test("adoptCid on a walk_in-source person overwrites the CID with source purchase and logs one overwritten conflict", async () => {
    const oldCid = testCid();
    const newCid = testCid();
    const personId = await insertPerson({ cid: oldCid, cidSource: "walk_in" });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawCid: newCid });

    const result = await matchPurchaseToPerson(judoClubId, purchaseId, personId, { adoptCid: true }, ADMIN_EMAIL);
    expect(result.cid.decision).toBe("overwrite");

    const person = await getPerson(personId);
    expect(person.cid).toBe(newCid);
    expect(person.cid_source).toBe("purchase");
    const conflicts = await conflictsFor(personId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ outcome: "overwritten", existing_cid: oldCid, incoming_cid: newCid });
  });

  test("adoptCid normalises a 7-digit purchase CID", async () => {
    const seven = testCid().slice(1);
    const personId = await insertPerson({});
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawCid: seven });

    const result = await matchPurchaseToPerson(judoClubId, purchaseId, personId, { adoptCid: true }, ADMIN_EMAIL);
    expect(result.cid.decision).toBe("set");
    expect((await getPerson(personId)).cid).toBe(`0${seven}`);
  });

  // The brief says "flagged" here, but the trust rule (cid-rule.ts) ranks sso
  // above purchase, so lower-ranked evidence is recorded as `ignored`. The
  // equal-rank test below covers the `flagged` path.
  test("adoptCid on a person holding an sso CID leaves the CID, keeps the match, and records the conflict", async () => {
    const ssoCid = testCid();
    const purchaseCid = testCid();
    const personId = await insertPerson({ cid: ssoCid, cidSource: "sso" });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawCid: purchaseCid });

    const result = await matchPurchaseToPerson(judoClubId, purchaseId, personId, { adoptCid: true }, ADMIN_EMAIL);
    expect(result.cid.decision).toBe("ignore");

    const person = await getPerson(personId);
    expect(person.cid).toBe(ssoCid);
    expect(person.cid_source).toBe("sso");
    expect((await getPurchase(purchaseId)).match_status).toBe("manual_matched");
    const conflicts = await conflictsFor(personId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ outcome: "ignored", incoming_cid: purchaseCid, incoming_source: "purchase" });
  });

  test("adoptCid on a person holding an equal-rank (purchase) CID flags", async () => {
    const existing = testCid();
    const incoming = testCid();
    const personId = await insertPerson({ cid: existing, cidSource: "purchase" });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawCid: incoming });

    const result = await matchPurchaseToPerson(judoClubId, purchaseId, personId, { adoptCid: true }, ADMIN_EMAIL);
    expect(result.cid.decision).toBe("flag");
    expect((await getPerson(personId)).cid).toBe(existing);
    const conflicts = await conflictsFor(personId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ outcome: "flagged", status: "open" });
  });

  test("adoptCid false does no CID work", async () => {
    const oldCid = testCid();
    const personId = await insertPerson({ cid: oldCid, cidSource: "walk_in" });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawCid: testCid() });

    const result = await matchPurchaseToPerson(judoClubId, purchaseId, personId, { adoptCid: false }, ADMIN_EMAIL);
    expect(result.cid.decision).toBe("none");
    expect((await getPerson(personId)).cid).toBe(oldCid);
    expect(await conflictsFor(personId)).toHaveLength(0);
  });

  test("an already-matched purchase is refused", async () => {
    const owner = await insertPerson({});
    const other = await insertPerson({});
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, personId: owner, matchStatus: "email_matched" });

    await expect(
      matchPurchaseToPerson(judoClubId, purchaseId, other, { adoptCid: false }, ADMIN_EMAIL)
    ).rejects.toThrow("Purchase is not unmatched");
    const purchase = await getPurchase(purchaseId);
    expect(purchase.person_id).toBe(owner);
    expect(purchase.match_status).toBe("email_matched");
  });

  test("a purchase from another club is refused", async () => {
    const personId = await insertPerson({});
    const tkdProduct = await insertProduct(taekwondoClubId);
    const purchaseId = await insertPurchase({ clubId: taekwondoClubId, productId: tkdProduct });

    await expect(
      matchPurchaseToPerson(judoClubId, purchaseId, personId, { adoptCid: false }, ADMIN_EMAIL)
    ).rejects.toThrow("Purchase not found");
    expect((await getPurchase(purchaseId)).match_status).toBe("unmatched");
  });

  test("a person from another club is refused", async () => {
    const tkdPerson = await insertPerson({ clubId: taekwondoClubId });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId });

    await expect(
      matchPurchaseToPerson(judoClubId, purchaseId, tkdPerson, { adoptCid: false }, ADMIN_EMAIL)
    ).rejects.toThrow("Person not found");
    const purchase = await getPurchase(purchaseId);
    expect(purchase.match_status).toBe("unmatched");
    expect(purchase.person_id).toBeNull();
  });

  test("rematchUnmatchedPurchases never changes a manual_matched row", async () => {
    // The purchase's CID belongs to a different person, so an automatic
    // rematch would pick them if it ever looked at this row.
    const cid = testCid();
    const cidOwner = await insertPerson({ cid, cidSource: "sso" });
    const chosen = await insertPerson({});
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawCid: cid });

    await matchPurchaseToPerson(judoClubId, purchaseId, chosen, { adoptCid: false }, ADMIN_EMAIL);
    await rematchUnmatchedPurchases(judoClubId);

    const purchase = await getPurchase(purchaseId);
    expect(purchase.person_id).toBe(chosen);
    expect(purchase.person_id).not.toBe(cidOwner);
    expect(purchase.match_status).toBe("manual_matched");
  });
});

test.describe("suggestPersonsForPurchase", () => {
  test("lists the email match first with its cidEffect, then a unique name match", async () => {
    const email = testEmail();
    const uniqueName = `Unique Match ${randomUUID()}`;
    const emailPerson = await insertPerson({ email, cid: testCid(), cidSource: "walk_in" });
    const namePerson = await insertPerson({ fullName: uniqueName });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({
      productId,
      rawName: uniqueName.toUpperCase(),
      rawEmail: email.toUpperCase(),
      rawCid: testCid(),
    });

    const suggestions = await suggestPersonsForPurchase(judoClubId, purchaseId);
    expect(suggestions.map((s) => s.personId)).toEqual([emailPerson, namePerson]);
    expect(suggestions[0]).toMatchObject({ email, cidSource: "walk_in", cidEffect: "overwrite" });
    expect(suggestions[1]).toMatchObject({ fullName: uniqueName, cid: null, cidEffect: "set" });
  });

  test("cidEffect is 'none' when the purchase has no CID", async () => {
    const email = testEmail();
    const personId = await insertPerson({ email });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawEmail: email, rawCid: null });

    const suggestions = await suggestPersonsForPurchase(judoClubId, purchaseId);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ personId, cidEffect: "none" });
  });

  test("two people with the same name give no name suggestion", async () => {
    const sharedName = `Twin Name ${randomUUID()}`;
    await insertPerson({ fullName: sharedName });
    await insertPerson({ fullName: sharedName });
    const productId = await insertProduct();
    const purchaseId = await insertPurchase({ productId, rawName: sharedName });

    expect(await suggestPersonsForPurchase(judoClubId, purchaseId)).toEqual([]);
  });

  test("a purchase from another club yields an error", async () => {
    const tkdProduct = await insertProduct(taekwondoClubId);
    const purchaseId = await insertPurchase({ clubId: taekwondoClubId, productId: tkdProduct });
    await expect(suggestPersonsForPurchase(judoClubId, purchaseId)).rejects.toThrow("Purchase not found");
  });
});
