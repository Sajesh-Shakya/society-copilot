import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import { ingestPurchases, rematchUnmatchedPurchases } from "@/lib/purchase/interface";
import type { RawPurchaseRow } from "@/lib/purchase/types";

const admin = createAdminClient();

test.describe("ingestPurchases", () => {
  let personId = "";
  let sessionIds: string[] = [];
  let productId: string | undefined;

  test.afterEach(async () => {
    // attendance_record must be cleared (or at least un-waived) before
    // purchase is deleted: attendance_record.waived_by_purchase_id FKs to
    // purchase, and this suite's own tests cause rows to actually get
    // waived, so deleting purchase first violates that FK.
    if (sessionIds.length > 0) {
      const { error: attendanceDeleteError } = await admin
        .from("attendance_record")
        .delete()
        .in("session_id", sessionIds);
      if (attendanceDeleteError) {
        throw new Error(`Cleanup failed deleting attendance_record: ${attendanceDeleteError.message}`);
      }

      const { error: sessionDeleteError } = await admin
        .from("session")
        .delete()
        .in("id", sessionIds);
      if (sessionDeleteError) {
        throw new Error(`Cleanup failed deleting session: ${sessionDeleteError.message}`);
      }
      sessionIds = [];
    }

    if (personId) {
      const { error: purchaseDeleteError } = await admin
        .from("purchase")
        .delete()
        .eq("person_id", personId);
      if (purchaseDeleteError) {
        throw new Error(`Cleanup failed deleting purchase: ${purchaseDeleteError.message}`);
      }
    }

    if (productId) {
      const { error: productDeleteError } = await admin.from("product").delete().eq("id", productId);
      if (productDeleteError) {
        throw new Error(`Cleanup failed deleting product: ${productDeleteError.message}`);
      }
      productId = undefined;
    }

    if (personId) {
      const { error: personDeleteError } = await admin.from("person").delete().eq("id", personId);
      if (personDeleteError) {
        throw new Error(`Cleanup failed deleting person: ${personDeleteError.message}`);
      }
      personId = "";
    }
  });

  async function createPerson(email: string): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({ email, full_name: "Ingest Test Person" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test person: ${error?.message}`);
    return data.id;
  }

  async function createAttendance(pid: string, startsAt: string): Promise<string> {
    const { data: session, error: sessionError } = await admin
      .from("session")
      .insert({ title: "Test Session", starts_at: startsAt })
      .select("id")
      .single();
    if (sessionError || !session) throw new Error(`Failed to create test session: ${sessionError?.message}`);
    sessionIds.push(session.id);

    const { error: attendanceError } = await admin
      .from("attendance_record")
      .insert({ person_id: pid, session_id: session.id, source: "manual_tick", attended: true });
    if (attendanceError) throw new Error(`Failed to create test attendance: ${attendanceError.message}`);

    return session.id;
  }

  test("ingesting a purchase for an already-curated annual pass automatically waives debt", async () => {
    const email = `ingest-test-${randomUUID()}@example.test`;
    personId = await createPerson(email);
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1

    expect(await getOutstandingDebt(personId)).toBe(1);

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Annual Pass ${randomUUID()}`, kind: "annual_pass", covers_days: 365 })
      .select("id, name")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const row: RawPurchaseRow = {
      externalId: `ingest-test-${randomUUID()}`,
      personName: "Ingest Test Person",
      personEmail: email,
      memberType: "Public",
      productName: product.name,
      purchasedAt: new Date("2026-02-01T00:00:00.000Z"),
      source: "xlsx_upload",
    };

    const result = await ingestPurchases([row]);

    expect(result.inserted).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toHaveLength(0);
    // The waiver call is wired directly into ingestPurchases()'s insert
    // loop -- no separate applyWaivers() call needed when the product is
    // already correctly curated at ingest time.
    expect(await getOutstandingDebt(personId)).toBe(0);
  });

  test("re-ingesting the same purchase row is idempotent and does not re-trigger or break the waiver", async () => {
    const email = `ingest-test-${randomUUID()}@example.test`;
    personId = await createPerson(email);
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Annual Pass ${randomUUID()}`, kind: "annual_pass", covers_days: 365 })
      .select("id, name")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const row: RawPurchaseRow = {
      externalId: `ingest-test-${randomUUID()}`,
      personName: "Ingest Test Person",
      personEmail: email,
      memberType: "Public",
      productName: product.name,
      purchasedAt: new Date("2026-02-01T00:00:00.000Z"),
      source: "xlsx_upload",
    };

    const first = await ingestPurchases([row]);
    expect(first.inserted).toBe(1);
    expect(await getOutstandingDebt(personId)).toBe(0);

    const second = await ingestPurchases([row]);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.errors).toHaveLength(0);
    expect(await getOutstandingDebt(personId)).toBe(0); // unchanged, not re-waived incorrectly
  });

  test("a row with an explicit productId (the real XLSX-upload path) resolves directly, skipping by-name lookup", async () => {
    const email = `ingest-test-${randomUUID()}@example.test`;
    personId = await createPerson(email);
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Annual Pass ${randomUUID()}`, kind: "annual_pass", covers_days: 365 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    // No productName at all -- mirrors what lib/xlsx/parser.ts now
    // actually produces for a real export (the admin-selected product,
    // stamped onto every row, with no product column in the file).
    const row: RawPurchaseRow = {
      externalId: `ingest-test-${randomUUID()}`,
      personName: "Ingest Test Person",
      personEmail: email,
      memberType: "Public",
      productId,
      purchasedAt: new Date("2026-02-01T00:00:00.000Z"),
      source: "xlsx_upload",
    };

    const result = await ingestPurchases([row]);

    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(await getOutstandingDebt(personId)).toBe(0);

    const { data: inserted } = await admin
      .from("purchase")
      .select("product_id")
      .eq("source_row_id", row.externalId)
      .single();
    expect(inserted!.product_id).toBe(productId);
  });

  test("a row with neither productId nor productName is rejected with a clear error", async () => {
    const row: RawPurchaseRow = {
      externalId: `ingest-test-${randomUUID()}`,
      personName: "No Product Person",
      memberType: "Public",
      purchasedAt: new Date("2026-02-01T00:00:00.000Z"),
      source: "xlsx_upload",
    };

    const result = await ingestPurchases([row]);

    expect(result.inserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toMatch(/productId or productName is required/);
  });
});

test.describe("rematchUnmatchedPurchases", () => {
  let personId = "";
  let sessionIds: string[] = [];
  let productId: string | undefined;
  let purchaseId: string | undefined;

  test.afterEach(async () => {
    // attendance_record must be cleared before purchase is deleted --
    // applyWaivers may have set attendance_record.waived_by_purchase_id
    // to this purchase, and that FK blocks deleting purchase first (see
    // the other describe block's afterEach above, which gets this order
    // right -- this one didn't, and silently left orphaned purchase/
    // product rows in the live database every run until caught).
    if (sessionIds.length > 0) {
      const { error: attendanceDeleteError } = await admin
        .from("attendance_record")
        .delete()
        .in("session_id", sessionIds);
      if (attendanceDeleteError) {
        throw new Error(`Cleanup failed deleting attendance_record: ${attendanceDeleteError.message}`);
      }
      const { error: sessionDeleteError } = await admin.from("session").delete().in("id", sessionIds);
      if (sessionDeleteError) {
        throw new Error(`Cleanup failed deleting session: ${sessionDeleteError.message}`);
      }
      sessionIds = [];
    }
    if (purchaseId) {
      const { error: purchaseDeleteError } = await admin.from("purchase").delete().eq("id", purchaseId);
      if (purchaseDeleteError) {
        throw new Error(`Cleanup failed deleting purchase: ${purchaseDeleteError.message}`);
      }
      purchaseId = undefined;
    }
    if (productId) {
      const { error: productDeleteError } = await admin.from("product").delete().eq("id", productId);
      if (productDeleteError) {
        throw new Error(`Cleanup failed deleting product: ${productDeleteError.message}`);
      }
      productId = undefined;
    }
    if (personId) {
      const { error: personDeleteError } = await admin.from("person").delete().eq("id", personId);
      if (personDeleteError) {
        throw new Error(`Cleanup failed deleting person: ${personDeleteError.message}`);
      }
      personId = "";
    }
  });

  test("matches and waives a purchase that was uploaded before the buyer's person/CID existed", async () => {
    const cid = String(Math.floor(10_000_000 + Math.random() * 80_000_000));

    // Simulates the real sequence that leaves a purchase stuck unmatched:
    // the file was uploaded (and matching ran, and failed) before this
    // person -- or their CID -- was ever recorded.
    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Rematch Pass ${randomUUID()}`, kind: "session_pass", covers_sessions: 1 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `rematch-test-${randomUUID()}`,
        raw_person_name: "Rematch Test Person",
        raw_cid: cid,
        raw_member_type: "Student",
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "unmatched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    // The person (with the matching CID) only shows up afterward.
    const { data: person, error: personError } = await admin
      .from("person")
      .insert({ full_name: "Rematch Test Person", email: `rematch-test-${randomUUID()}@example.test`, cid })
      .select("id")
      .single();
    if (personError || !person) throw new Error(`Failed to create test person: ${personError?.message}`);
    personId = person.id;

    // Two sessions: the first is always the free trial (never debt, see
    // outstanding_attendance's design), so a second is needed for there
    // to be any actual debt for the purchase to waive.
    const { data: freeSession, error: freeSessionError } = await admin
      .from("session")
      .insert({ title: "Test Session (free trial)", starts_at: "2026-01-01T18:00:00.000Z" })
      .select("id")
      .single();
    if (freeSessionError || !freeSession) throw new Error(`Failed to create test session: ${freeSessionError?.message}`);
    sessionIds.push(freeSession.id);
    await admin
      .from("attendance_record")
      .insert({ person_id: personId, session_id: freeSession.id, source: "manual_tick", attended: true });

    const { data: session, error: sessionError } = await admin
      .from("session")
      .insert({ title: "Test Session (debt)", starts_at: "2026-01-08T18:00:00.000Z" })
      .select("id")
      .single();
    if (sessionError || !session) throw new Error(`Failed to create test session: ${sessionError?.message}`);
    sessionIds.push(session.id);
    await admin
      .from("attendance_record")
      .insert({ person_id: personId, session_id: session.id, source: "manual_tick", attended: true });

    const before = await admin.from("purchase").select("match_status, person_id").eq("id", purchaseId).single();
    expect(before.data!.match_status).toBe("unmatched");

    const result = await rematchUnmatchedPurchases();

    expect(result.matched).toBeGreaterThanOrEqual(1);

    const after = await admin.from("purchase").select("match_status, person_id").eq("id", purchaseId).single();
    expect(after.data!.match_status).toBe("cid_matched");
    expect(after.data!.person_id).toBe(personId);

    const { data: attendance } = await admin
      .from("attendance_record")
      .select("waived_by_purchase_id")
      .eq("person_id", personId)
      .eq("session_id", session.id)
      .single();
    expect(attendance!.waived_by_purchase_id).toBe(purchaseId);
  });

  test("a purchase with no matching person stays unmatched and is reported as such", async () => {
    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Rematch Pass ${randomUUID()}`, kind: "session_pass", covers_sessions: 1 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `rematch-test-${randomUUID()}`,
        raw_person_name: `Nobody Matches ${randomUUID()}`,
        raw_cid: String(Math.floor(10_000_000 + Math.random() * 80_000_000)),
        raw_member_type: "Student",
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "unmatched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    const result = await rematchUnmatchedPurchases();

    expect(result.stillUnmatched).toBeGreaterThanOrEqual(1);

    const after = await admin.from("purchase").select("match_status").eq("id", purchaseId).single();
    expect(after.data!.match_status).toBe("unmatched");
  });
});
