import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import {
  applyWaivers,
  changeUploadProduct,
  undoUpload,
  listRecentUploads,
} from "@/lib/purchase/interface";

const admin = createAdminClient();

test.describe("purchase upload batches", () => {
  let personId = "";
  let sessionIds: string[] = [];
  let productIds: string[] = [];
  let uploadIds: string[] = [];
  let purchaseIds: string[] = [];

  test.afterEach(async () => {
    if (purchaseIds.length > 0) {
      await admin.from("purchase").delete().in("id", purchaseIds);
      purchaseIds = [];
    }
    if (uploadIds.length > 0) {
      await admin.from("purchase_upload").delete().in("id", uploadIds);
      uploadIds = [];
    }
    if (sessionIds.length > 0) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (productIds.length > 0) {
      await admin.from("product").delete().in("id", productIds);
      productIds = [];
    }
    if (personId) {
      await admin.from("person").delete().eq("id", personId);
      personId = "";
    }
  });

  async function createPerson(): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({ email: `upload-test-${randomUUID()}@example.test`, full_name: "Upload Test Person" })
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

  async function createProduct(coversSessions: number): Promise<string> {
    const { data, error } = await admin
      .from("product")
      .insert({ name: `Test Upload Pass ${randomUUID()}`, kind: "session_pass", covers_sessions: coversSessions })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test product: ${error?.message}`);
    productIds.push(data.id);
    return data.id;
  }

  async function createUpload(productId: string): Promise<string> {
    const { data, error } = await admin
      .from("purchase_upload")
      .insert({ product_id: productId, filename: "test.xlsx", row_count: 1, uploaded_by: "test@example.test" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test upload: ${error?.message}`);
    uploadIds.push(data.id);
    return data.id;
  }

  async function createPurchase(pid: string, productId: string, uploadId: string): Promise<string> {
    const { data, error } = await admin
      .from("purchase")
      .insert({
        person_id: pid,
        product_id: productId,
        upload_id: uploadId,
        source: "xlsx_upload",
        source_row_id: `upload-test-${randomUUID()}`,
        raw_person_name: "Upload Test Person",
        match_status: "cid_matched",
        purchased_at: "2026-02-01T00:00:00.000Z",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test purchase: ${error?.message}`);
    purchaseIds.push(data.id);
    return data.id;
  }

  test("listRecentUploads returns batches newest-first with the product name resolved", async () => {
    personId = await createPerson();
    const productA = await createProduct(1);
    const productB = await createProduct(2);
    const uploadA = await createUpload(productA);
    await new Promise((r) => setTimeout(r, 10)); // ensure distinct created_at ordering
    const uploadB = await createUpload(productB);

    const uploads = await listRecentUploads(5);
    const ids = uploads.map((u) => u.id);
    expect(ids.indexOf(uploadB)).toBeLessThan(ids.indexOf(uploadA));

    const found = uploads.find((u) => u.id === uploadB)!;
    expect(found.rowCount).toBe(1);
    expect(found.filename).toBe("test.xlsx");
    expect(typeof found.productName).toBe("string");
  });

  test("changeUploadProduct re-waives under the new product's rule, un-waiving the old one first", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1
    await createAttendance(personId, "2026-01-15T18:00:00.000Z"); // debt #2
    await createAttendance(personId, "2026-01-22T18:00:00.000Z"); // debt #3

    expect(await getOutstandingDebt(personId)).toBe(3);

    // Wrongly uploaded as a 1-session pass...
    const wrongProduct = await createProduct(1);
    const uploadId = await createUpload(wrongProduct);
    const purchaseId = await createPurchase(personId, wrongProduct, uploadId);
    await applyWaivers(personId, purchaseId);
    expect(await getOutstandingDebt(personId)).toBe(2); // only 1 waived

    // ...corrected to the 3-session pass it should have been.
    const rightProduct = await createProduct(3);
    const result = await changeUploadProduct(uploadId, rightProduct);

    expect(result.purchasesUpdated).toBe(1);
    expect(result.rewaived).toBe(3);
    expect(await getOutstandingDebt(personId)).toBe(0);

    const { data: updatedPurchase } = await admin
      .from("purchase")
      .select("product_id")
      .eq("id", purchaseId)
      .single();
    expect(updatedPurchase!.product_id).toBe(rightProduct);
  });

  test("undoUpload removes the purchase and un-waives whatever it had waived", async () => {
    personId = await createPerson();
    await createAttendance(personId, "2026-01-01T18:00:00.000Z"); // free trial
    await createAttendance(personId, "2026-01-08T18:00:00.000Z"); // debt #1

    expect(await getOutstandingDebt(personId)).toBe(1);

    const product = await createProduct(1);
    const uploadId = await createUpload(product);
    const purchaseId = await createPurchase(personId, product, uploadId);
    await applyWaivers(personId, purchaseId);
    expect(await getOutstandingDebt(personId)).toBe(0);

    const result = await undoUpload(uploadId);
    expect(result.deletedPurchases).toBe(1);
    purchaseIds = purchaseIds.filter((id) => id !== purchaseId); // already deleted
    uploadIds = uploadIds.filter((id) => id !== uploadId); // already deleted

    expect(await getOutstandingDebt(personId)).toBe(1); // debt is back

    const { data: deletedPurchase } = await admin.from("purchase").select("id").eq("id", purchaseId).maybeSingle();
    expect(deletedPurchase).toBeNull();

    const { data: deletedUpload } = await admin
      .from("purchase_upload")
      .select("id")
      .eq("id", uploadId)
      .maybeSingle();
    expect(deletedUpload).toBeNull();
  });
});
