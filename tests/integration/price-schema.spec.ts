import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

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
    await admin.from("product").delete().in("id", productIds);
    productIds = [];
  }
});

test("club exposes target and pause defaults", async () => {
  const { data, error } = await admin
    .from("club")
    .select("signup_target, signup_min, chase_auto_send_paused")
    .eq("id", judoClubId)
    .single();
  expect(error).toBeNull();
  expect(data).toEqual({ signup_target: 20, signup_min: 15, chase_auto_send_paused: false });
});

test("product exposes price_pence, active default and external_sales_id", async () => {
  const { data, error } = await admin.from("product").select("price_pence, active, external_sales_id").limit(1);
  expect(error).toBeNull();
  // Not asserting true: real products can be retired (active = false).
  expect(typeof (data?.[0] as { active: unknown }).active).toBe("boolean");
  expect(data?.[0]).toHaveProperty("price_pence");
  expect(data?.[0]).toHaveProperty("external_sales_id");
});

test("person, chase_email and purchase expose new columns", async () => {
  for (const [table, cols] of [
    ["person", "chase_auto_approved_at, chase_auto_approved_by"],
    ["chase_email", "auto_approved"],
    ["purchase", "price_pence"],
  ] as const) {
    const { error } = await admin.from(table).select(cols).limit(1);
    expect(error, table).toBeNull();
  }
});

test("negative product price is rejected, valid price accepted", async () => {
  const name = `Schema Test ${crypto.randomUUID()}`;
  const bad = await admin.from("product").insert({ club_id: judoClubId, name, kind: "other", price_pence: -1 });
  expect(bad.error).not.toBeNull();
  const ok = await admin
    .from("product")
    .insert({ club_id: judoClubId, name, kind: "other", price_pence: 500 })
    .select("id")
    .single();
  expect(ok.error).toBeNull();
  productIds.push(ok.data!.id);
});

test("club signup_min greater than signup_target is rejected", async () => {
  const { error } = await admin.from("club").update({ signup_min: 30, signup_target: 20 }).eq("id", judoClubId);
  expect(error).not.toBeNull();
});
