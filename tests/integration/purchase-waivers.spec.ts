import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import {
  applyWaivers,
  reapplyWaiversForPerson,
  reapplyWaiversForEveryoneWithDebt,
} from "@/lib/purchase/interface";

const admin = createAdminClient();

test.describe("applyWaivers", () => {
  let personId = "";
  let sessionIds: string[] = [];
  let productId: string | undefined;
  let purchaseId: string | undefined;

  test.afterEach(async () => {
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

  test("a session_pass with covers_until does not waive a session on or after the cutoff", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1, before cutoff
    await createAttendance(personId, "2026-01-22T18:00:00.000Z"); // debt #2, on/after cutoff

    expect(await getOutstandingDebt(personId)).toBe(2);

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({
        name: `Test Expiring Session Pack ${randomUUID()}`,
        kind: "session_pass",
        covers_sessions: 5, // generous cap -- covers_until should be the binding limit
        covers_until: "2026-01-15T00:00:00.000Z",
      })
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

    // Only the pre-cutoff session is waived -- covers_sessions=5 would
    // otherwise have waived both.
    expect(waivedCount).toBe(1);
    expect(await getOutstandingDebt(personId)).toBe(1);
  });

  test("a term_pass with covers_until excludes only sessions before the absolute cutoff, continuously", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-10T18:00:00.000Z"); // within the pass window
    await createAttendance(personId, "2026-01-25T18:00:00.000Z"); // after covers_until

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({
        name: `Test Expiring Term Pass ${randomUUID()}`,
        kind: "term_pass",
        covers_until: "2026-01-20T00:00:00.000Z",
      })
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
        purchased_at: "2026-01-05T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    // Unlike session_pass, term/annual coverage is continuous (enforced by
    // outstanding_attendance's own window check), not a one-time waive --
    // no applyWaivers call needed for the within-window session to
    // disappear from debt.
    expect(await getOutstandingDebt(personId)).toBe(1); // only the post-cutoff session
  });
});

test.describe("reapplyWaiversForPerson", () => {
  let personId = "";
  let sessionIds: string[] = [];
  let productId: string | undefined;
  let purchaseId: string | undefined;

  test.afterEach(async () => {
    if (sessionIds.length > 0) {
      const { error: attendanceDeleteError } = await admin
        .from("attendance_record")
        .delete()
        .in("session_id", sessionIds);
      if (attendanceDeleteError) throw new Error(`Cleanup failed: ${attendanceDeleteError.message}`);
      const { error: sessionDeleteError } = await admin.from("session").delete().in("id", sessionIds);
      if (sessionDeleteError) throw new Error(`Cleanup failed: ${sessionDeleteError.message}`);
      sessionIds = [];
    }
    if (purchaseId) {
      const { error } = await admin.from("purchase").delete().eq("id", purchaseId);
      if (error) throw new Error(`Cleanup failed: ${error.message}`);
      purchaseId = undefined;
    }
    if (productId) {
      const { error } = await admin.from("product").delete().eq("id", productId);
      if (error) throw new Error(`Cleanup failed: ${error.message}`);
      productId = undefined;
    }
    if (personId) {
      const { error } = await admin.from("person").delete().eq("id", personId);
      if (error) throw new Error(`Cleanup failed: ${error.message}`);
      personId = "";
    }
  });

  async function createPerson(): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({ email: `reapply-test-${randomUUID()}@example.test`, full_name: "Reapply Test Person" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test person: ${error?.message}`);
    return data.id;
  }

  async function createAttendance(pid: string, startsAt: string, attended: boolean): Promise<string> {
    const { data: session, error: sessionError } = await admin
      .from("session")
      .insert({ title: "Test Session", starts_at: startsAt })
      .select("id")
      .single();
    if (sessionError || !session) throw new Error(`Failed to create test session: ${sessionError?.message}`);
    sessionIds.push(session.id);
    const { error: attendanceError } = await admin
      .from("attendance_record")
      .insert({ person_id: pid, session_id: session.id, source: "csv_import", attended });
    if (attendanceError) throw new Error(`Failed to create test attendance: ${attendanceError.message}`);
    return session.id;
  }

  test("catches debt that only appeared AFTER the purchase was already ingested and waived", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z", true); // free trial

    // A roster row exists for this session already (e.g. CSV-imported
    // ahead of time) but hasn't been ticked attended yet -- no debt yet.
    const debtSessionId = await createAttendance(personId, "2026-01-08T18:00:00.000Z", false);
    expect(await getOutstandingDebt(personId)).toBe(0);

    // The purchase gets ingested and waived while there's still nothing
    // to waive -- exactly what happens when a pass is bought before the
    // admin ticks the roster.
    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Reapply Pass ${randomUUID()}`, kind: "session_pass", covers_sessions: 1 })
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
        source_row_id: `reapply-test-${randomUUID()}`,
        purchased_at: "2026-01-05T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    expect(await applyWaivers(personId, purchase.id)).toBe(0); // nothing to waive yet

    // The admin ticks the roster afterward -- real debt appears, but
    // applyWaivers never runs again on its own.
    await admin.from("attendance_record").update({ attended: true }).eq("session_id", debtSessionId);
    expect(await getOutstandingDebt(personId)).toBe(1);

    // This is the fix: re-checking the person's existing purchase now
    // finds and waives the debt that appeared after the fact.
    const waived = await reapplyWaiversForPerson(personId);
    expect(waived).toBe(1);
    expect(await getOutstandingDebt(personId)).toBe(0);
  });

  test("is a no-op when there is nothing new to waive", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z", true); // free trial only

    const waived = await reapplyWaiversForPerson(personId);
    expect(waived).toBe(0);
  });

  test("reapplyWaiversForEveryoneWithDebt catches the same gap for anyone currently showing debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z", true); // free trial
    const debtSessionId = await createAttendance(personId, "2026-01-08T18:00:00.000Z", false); // not ticked yet

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Sweep Pass ${randomUUID()}`, kind: "session_pass", covers_sessions: 1 })
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
        source_row_id: `sweep-test-${randomUUID()}`,
        purchased_at: "2026-01-05T00:00:00.000Z",
        match_status: "cid_matched",
      })
      .select("id")
      .single();
    if (purchaseError || !purchase) throw new Error(`Failed to create test purchase: ${purchaseError?.message}`);
    purchaseId = purchase.id;

    await admin.from("attendance_record").update({ attended: true }).eq("session_id", debtSessionId);
    expect(await getOutstandingDebt(personId)).toBe(1);

    const result = await reapplyWaiversForEveryoneWithDebt();

    // Tolerant: this sweep is global and may also process other real
    // debtors in the live project -- only this test's own person is
    // asserted on directly.
    expect(result.peopleChecked).toBeGreaterThanOrEqual(1);
    expect(result.totalWaived).toBeGreaterThanOrEqual(1);
    expect(await getOutstandingDebt(personId)).toBe(0);
  });
});
