import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";

const admin = createAdminClient();

test.describe("getOutstandingDebt", () => {
  let personId: string;
  let sessionIds: string[] = [];
  let productId: string | undefined;

  test.afterEach(async () => {
    if (productId) {
      await admin.from("purchase").delete().eq("product_id", productId);
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
      .insert({ email: `debt-test-${randomUUID()}@example.test`, full_name: "Debt Test Person" })
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

  test("a single attendance record is the free trial and does not count as debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z");

    expect(await getOutstandingDebt(personId)).toBe(0);
  });

  test("a second attendance record counts as debt (first is the free trial)", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z");
    await createAttendance(personId, "2026-01-08T18:00:00.000Z");

    expect(await getOutstandingDebt(personId)).toBe(1);
  });

  test("attendance covered by an active term pass does not count as debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // would-be debt, but covered below

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { error: purchaseError } = await admin.from("purchase").insert({
      person_id: personId,
      product_id: productId,
      source: "xlsx_upload",
      source_row_id: `debt-test-${randomUUID()}`,
      purchased_at: "2026-01-05T00:00:00.000Z", // before the covered session
      match_status: "cid_matched",
    });
    if (purchaseError) throw new Error(`Failed to create test purchase: ${purchaseError.message}`);

    expect(await getOutstandingDebt(personId)).toBe(0);
  });

  test("attendance after a term pass expires resumes counting as debt", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-04-01T18:00:00.000Z"); // well past a 70-day window from Jan 5

    const { data: product, error: productError } = await admin
      .from("product")
      .insert({ name: `Test Term Pass ${randomUUID()}`, kind: "term_pass", covers_days: 70 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`Failed to create test product: ${productError?.message}`);
    productId = product.id;

    const { error: purchaseError } = await admin.from("purchase").insert({
      person_id: personId,
      product_id: productId,
      source: "xlsx_upload",
      source_row_id: `debt-test-${randomUUID()}`,
      purchased_at: "2026-01-05T00:00:00.000Z",
      match_status: "cid_matched",
    });
    if (purchaseError) throw new Error(`Failed to create test purchase: ${purchaseError.message}`);

    expect(await getOutstandingDebt(personId)).toBe(1);
  });
});
