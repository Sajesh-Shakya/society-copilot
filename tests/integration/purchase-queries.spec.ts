import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listProducts } from "@/lib/purchase/queries";

const admin = createAdminClient();

let judoClubId: string;
let taekwondoClubId: string;
test.beforeAll(async () => {
  const { data: judo, error: judoError } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (judoError) throw judoError;
  judoClubId = judo.id;
  const { data: taekwondo, error: tkdError } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  if (tkdError) throw tkdError;
  taekwondoClubId = taekwondo.id;
});

test.describe("listProducts", () => {
  let productIds: string[] = [];

  test.afterEach(async () => {
    if (productIds.length === 0) return;
    const { error } = await admin.from("product").delete().in("id", productIds);
    if (error) throw error;
    productIds = [];
  });

  test("never includes a product belonging to a different club", async () => {
    const judoName = `Judo Products Test ${crypto.randomUUID()}`;
    const tkdName = `Taekwondo Products Test ${crypto.randomUUID()}`;
    const { data: judoProduct, error: judoError } = await admin
      .from("product")
      .insert({ club_id: judoClubId, name: judoName, kind: "other" })
      .select("id")
      .single();
    if (judoError) throw judoError;
    const { data: tkdProduct, error: tkdError } = await admin
      .from("product")
      .insert({ club_id: taekwondoClubId, name: tkdName, kind: "other" })
      .select("id")
      .single();
    if (tkdError) throw tkdError;
    productIds.push(judoProduct!.id, tkdProduct!.id);

    const results = await listProducts(judoClubId);
    expect(results.some((p) => p.id === judoProduct!.id)).toBe(true);
    expect(results.some((p) => p.id === tkdProduct!.id)).toBe(false);
  });
});
