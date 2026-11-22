import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createProduct, updateProduct, applyPriceToUnpricedPurchases } from "@/lib/products/writer";
import { listProductsWithPrices } from "@/lib/products/queries";

const admin = createAdminClient();
let judoClubId: string;
let productIds: string[] = [];

test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});

test.afterEach(async () => {
  if (productIds.length) {
    const { error: pErr } = await admin.from("purchase").delete().in("product_id", productIds);
    if (pErr) throw new Error(`Cleanup purchase: ${pErr.message}`);
    const { error } = await admin.from("product").delete().in("id", productIds);
    if (error) throw new Error(`Cleanup product: ${error.message}`);
    productIds = [];
  }
});

const uniq = () => `Writer Test ${randomUUID()}`;

async function made(input: Partial<Parameters<typeof createProduct>[1]> = {}) {
  const res = await createProduct(judoClubId, {
    name: uniq(),
    kind: "other",
    coversSessions: null,
    pricePence: null,
    externalSalesId: null,
    ...input,
  });
  if ("error" in res) throw new Error(res.error);
  productIds.push(res.id);
  return res.id;
}

async function addPurchase(productId: string, pricePence: number | null) {
  const { data, error } = await admin
    .from("purchase")
    .insert({
      club_id: judoClubId,
      product_id: productId,
      source: "xlsx_upload",
      source_row_id: `prod-test-${randomUUID()}`,
      purchased_at: new Date().toISOString(),
      match_status: "unmatched",
      price_pence: pricePence,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function purchasePrice(id: string) {
  const { data, error } = await admin.from("purchase").select("price_pence").eq("id", id).single();
  if (error) throw error;
  return data.price_pence;
}

test("createProduct returns an id", async () => {
  const id = await made({ pricePence: 500 });
  expect(id).toBeTruthy();
});

test("blank name returns an error", async () => {
  const res = await createProduct(judoClubId, { name: "   ", kind: "other", coversSessions: null, pricePence: null, externalSalesId: null });
  expect(res).toHaveProperty("error");
});

test("negative price returns an error", async () => {
  const res = await createProduct(judoClubId, { name: uniq(), kind: "other", coversSessions: null, pricePence: -5, externalSalesId: null });
  expect(res).toHaveProperty("error");
});

test("session_pass requires coversSessions >= 1", async () => {
  const res = await createProduct(judoClubId, { name: uniq(), kind: "session_pass", coversSessions: null, pricePence: null, externalSalesId: null });
  expect(res).toHaveProperty("error");
});

test("duplicate name per club returns the duplicate error", async () => {
  const name = uniq();
  await made({ name });
  const res = await createProduct(judoClubId, { name, kind: "other", coversSessions: null, pricePence: null, externalSalesId: null });
  expect(res).toEqual({ error: "A product with that name already exists." });
});

test("updateProduct price change leaves existing purchases untouched", async () => {
  const id = await made({ pricePence: 500 });
  const purchaseId = await addPurchase(id, 500);
  const res = await updateProduct(judoClubId, id, { pricePence: 900 });
  expect(res).toEqual({ ok: true });
  expect(await purchasePrice(purchaseId)).toBe(500);
  const { data } = await admin.from("product").select("price_pence").eq("id", id).single();
  expect(data!.price_pence).toBe(900);
});

test("applyPriceToUnpricedPurchases fills only null rows", async () => {
  const id = await made({ pricePence: 700 });
  const nullOne = await addPurchase(id, null);
  const priced = await addPurchase(id, 500);
  expect(await applyPriceToUnpricedPurchases(judoClubId, id)).toEqual({ updated: 1 });
  expect(await purchasePrice(nullOne)).toBe(700);
  expect(await purchasePrice(priced)).toBe(500);
});

test("applyPriceToUnpricedPurchases errors for an unpriced product", async () => {
  const id = await made({ pricePence: null });
  expect(await applyPriceToUnpricedPurchases(judoClubId, id)).toHaveProperty("error");
});

test("retiring a product keeps the row", async () => {
  const id = await made();
  expect(await updateProduct(judoClubId, id, { active: false })).toEqual({ ok: true });
  const { data } = await admin.from("product").select("active").eq("id", id).single();
  expect(data!.active).toBe(false);
});

test("updateProduct cannot touch another club's product", async () => {
  const id = await made();
  const { data: other } = await admin.from("club").select("id").neq("id", judoClubId).limit(1).single();
  const res = await updateProduct(other!.id, id, { name: "hijack" });
  expect(res).toHaveProperty("error");
});

test("listProductsWithPrices reports purchase counts", async () => {
  const id = await made({ pricePence: 500 });
  await addPurchase(id, 500);
  await addPurchase(id, null);
  await addPurchase(id, null);
  const rows = await listProductsWithPrices(judoClubId);
  const row = rows.find((r) => r.id === id)!;
  expect(row.purchaseCount).toBe(3);
  expect(row.unpricedPurchaseCount).toBe(2);
  expect(row.pricePence).toBe(500);
  expect(row.active).toBe(true);
});
