import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestPurchases } from "@/lib/purchase/interface";
import type { RawPurchaseRow } from "@/lib/purchase/types";

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

async function makeProduct(pricePence: number | null) {
  const { data, error } = await admin
    .from("product")
    .insert({ club_id: judoClubId, name: `Snapshot Test ${randomUUID()}`, kind: "other", price_pence: pricePence })
    .select("id, name")
    .single();
  if (error || !data) throw new Error(`product: ${error?.message}`);
  productIds.push(data.id);
  return data;
}

function row(extra: Partial<RawPurchaseRow>): RawPurchaseRow {
  return {
    externalId: `snap-${randomUUID()}`,
    personName: "Snapshot Nobody",
    memberType: "Public",
    purchasedAt: new Date("2026-02-01T00:00:00.000Z"),
    source: "xlsx_upload",
    ...extra,
  };
}

async function priceOf(sourceRowId: string) {
  const { data, error } = await admin
    .from("purchase")
    .select("price_pence")
    .eq("club_id", judoClubId)
    .eq("source_row_id", sourceRowId)
    .single();
  if (error) throw error;
  return data.price_pence;
}

test("price is snapshotted via productId and productName paths", async () => {
  const a = await makeProduct(500);
  const b = await makeProduct(800);
  const r1 = row({ productId: a.id });
  const r2 = row({ productName: b.name });
  const res = await ingestPurchases([r1, r2], judoClubId);
  expect(res.inserted).toBe(2);
  expect(await priceOf(r1.externalId)).toBe(500);
  expect(await priceOf(r2.externalId)).toBe(800);
});

test("later price change does not alter earlier purchases", async () => {
  const a = await makeProduct(500);
  const r1 = row({ productId: a.id });
  await ingestPurchases([r1], judoClubId);
  await admin.from("product").update({ price_pence: 900 }).eq("id", a.id);
  const r2 = row({ productId: a.id });
  await ingestPurchases([r2], judoClubId);
  expect(await priceOf(r1.externalId)).toBe(500);
  expect(await priceOf(r2.externalId)).toBe(900);
});

test("unpriced product gives null purchase price", async () => {
  const a = await makeProduct(null);
  const r1 = row({ productId: a.id });
  await ingestPurchases([r1], judoClubId);
  expect(await priceOf(r1.externalId)).toBeNull();
});
