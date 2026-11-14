import { test, expect, adminDb, acceptanceContext, seedPerson, seedProduct, seedPurchase } from "./support/fixtures";

// The "Ayaan" scenario: a student purchase was ingested before the person
// existed (or before their CID was known), so it sat as `unmatched`. Once the
// person is stored with that CID, "Re-check" must link it by CID.

async function purchaseRow(id: string) {
  const { data, error } = await adminDb.from("purchase").select("person_id, match_status").eq("id", id).single();
  if (error) throw error;
  return data;
}

test("Re-check matches an unmatched student purchase by CID", async ({ signedIn: page }) => {
  const { clubSlug } = acceptanceContext();
  const personId = await seedPerson({
    fullName: "Ayaan Azam (Imperial)",
    email: "ayaan.azam@example.test",
    cid: "06113211",
  });
  const productId = await seedProduct();
  const purchaseId = await seedPurchase({
    productId,
    matchStatus: "unmatched",
    rawPersonName: "Ayaan Azam",
    rawCid: "06113211",
    rawMemberType: "Student",
  });

  await page.goto(`/club/${clubSlug}/admin/purchases`);
  const row = page.getByRole("row").filter({ hasText: "Ayaan Azam" });
  await expect(row.getByText("unmatched", { exact: true })).toBeVisible();
  const button = page.getByRole("button", { name: "Re-check 1 unmatched" });
  await expect(button).toBeVisible();

  await button.click();

  await expect(page.getByText("Matched 1 purchase(s).")).toBeVisible();
  await expect(row.getByText("cid_matched", { exact: true })).toBeVisible();
  await expect(row.getByText("(matched: Ayaan Azam (Imperial))")).toBeVisible();
  await expect(page.getByRole("button", { name: /Re-check \d+ unmatched/ })).toHaveCount(0);

  const after = await purchaseRow(purchaseId);
  expect(after.person_id).toBe(personId);
  expect(after.match_status).toBe("cid_matched");
});

test("Re-check leaves a student purchase whose CID matches nobody unmatched", async ({ signedIn: page }) => {
  const { clubSlug } = acceptanceContext();
  // The person has a different CID; a student CID mismatch gets no email/name fallback.
  await seedPerson({ fullName: "Ayaan Azam", email: "ayaan.azam@example.test", cid: "06113211" });
  const productId = await seedProduct();
  const purchaseId = await seedPurchase({
    productId,
    matchStatus: "unmatched",
    rawPersonName: "Ayaan Azam",
    rawEmail: "ayaan.azam@example.test",
    rawCid: "09999999",
    rawMemberType: "Student",
  });

  await page.goto(`/club/${clubSlug}/admin/purchases`);
  const row = page.getByRole("row").filter({ hasText: "Ayaan Azam" });
  await expect(row.getByText("unmatched", { exact: true })).toBeVisible();
  const button = page.getByRole("button", { name: "Re-check 1 unmatched" });
  await expect(button).toBeVisible();

  await button.click();

  await expect(page.getByText(/No change — still unmatched/)).toBeVisible();
  await expect(row.getByText("unmatched", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-check 1 unmatched" })).toBeVisible();

  const after = await purchaseRow(purchaseId);
  expect(after.person_id).toBeNull();
  expect(after.match_status).toBe("unmatched");
});
