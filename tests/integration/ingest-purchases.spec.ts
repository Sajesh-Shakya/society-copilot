import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import { ingestPurchases } from "@/lib/purchase/interface";
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
});
