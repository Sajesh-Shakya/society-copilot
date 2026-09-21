import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import { applyWaivers } from "@/lib/purchase/interface";

const admin = createAdminClient();

test.describe("applyWaivers", () => {
  let personId: string;
  let sessionIds: string[] = [];
  let productId: string | undefined;
  let purchaseId: string | undefined;

  test.afterEach(async () => {
    if (purchaseId) {
      await admin.from("purchase").delete().eq("id", purchaseId);
      purchaseId = undefined;
    }
    if (productId) {
      await admin.from("product").delete().eq("id", productId);
      productId = undefined;
    }
    if (sessionIds.length > 0) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (personId) {
      await admin.from("person").delete().eq("id", personId);
    }
  });

  async function createPerson(): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({ email: `waiver-test-${randomUUID()}@example.test`, full_name: "Waiver Test Person" })
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
      .insert({ person_id: pid, session_id: session.id, source: "manual_tick" });
    if (attendanceError) throw new Error(`Failed to create test attendance: ${attendanceError.message}`);

    return session.id;
  }

  test("a term pass purchase waives all of a person's prior unpaid attendance", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial, never debt
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1
    await createAttendance(personId, "2026-01-15T18:00:00.000Z"); // debt #2

    expect(await getOutstandingDebt(personId)).toBe(2);

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        person_id: personId,
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `waiver-test-${randomUUID()}`,
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    const waivedCount = await applyWaivers(personId, purchaseId!);

    expect(waivedCount).toBe(2);
    expect(await getOutstandingDebt(personId)).toBe(0);

    const { data: rows } = await admin
      .from("attendance_record")
      .select("waived_by_purchase_id")
      .in("session_id", sessionIds);
    const nonWaived = rows?.filter((r) => r.waived_by_purchase_id === null) ?? [];
    // Only the free trial row should remain un-waived (it was never debt).
    expect(nonWaived).toHaveLength(1);
  });

  test("a session_pass purchase waives only up to covers_sessions of the oldest debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1 (oldest)
    await createAttendance(personId, "2026-01-15T18:00:00.000Z"); // debt #2
    await createAttendance(personId, "2026-01-22T18:00:00.000Z"); // debt #3

    expect(await getOutstandingDebt(personId)).toBe(3);

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Session Pack ${randomUUID()}`, kind: "session_pass", covers_sessions: 2 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        person_id: personId,
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `waiver-test-${randomUUID()}`,
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    const waivedCount = await applyWaivers(personId, purchaseId!);

    expect(waivedCount).toBe(2); // capped at covers_sessions, not all 3
    expect(await getOutstandingDebt(personId)).toBe(1); // one debt row remains

    const { data: waivedRows } = await admin
      .from("attendance_record")
      .select("id")
      .in("session_id", sessionIds)
      .eq("waived_by_purchase_id", purchaseId);
    expect(waivedRows).toHaveLength(2);
  });

  test("calling applyWaivers twice for the same purchase is idempotent", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { data: purchase, error: purchaseError } = await admin
      .from("purchase")
      .insert({
        person_id: personId,
        product_id: productId,
        source: "xlsx_upload",
        source_row_id: `waiver-test-${randomUUID()}`,
        purchased_at: "2026-02-01T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    const first = await applyWaivers(personId, purchaseId!);
    const second = await applyWaivers(personId, purchaseId!);

    expect(first).toBe(1);
    expect(second).toBe(0); // nothing left to waive the second time
  });
});
