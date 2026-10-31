import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("multi-tenancy schema", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];
  let purchaseIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) await admin.from("person").delete().in("id", personIds);
    if (sessionIds.length) await admin.from("session").delete().in("id", sessionIds);
    if (purchaseIds.length) await admin.from("purchase").delete().in("id", purchaseIds);
    personIds = [];
    sessionIds = [];
    purchaseIds = [];
  });

  test("person email uniqueness is still case-insensitive, now per club", async () => {
    const judo = await clubId("judo");
    const email = `dup-${crypto.randomUUID()}@example.test`;

    const first = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "First", email })
      .select("id")
      .single();
    expect(first.error).toBeNull();
    personIds.push(first.data!.id);

    const secondSameCase = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Second", email });
    expect(secondSameCase.error).not.toBeNull();

    const secondDifferentCase = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Second", email: email.toUpperCase() });
    expect(secondDifferentCase.error).not.toBeNull();
  });

  test("two people in the same club can both have a null cid", async () => {
    const judo = await clubId("judo");

    const first = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "No CID One", email: `nocid1-${crypto.randomUUID()}@example.test`, cid: null })
      .select("id")
      .single();
    expect(first.error).toBeNull();
    personIds.push(first.data!.id);

    const second = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "No CID Two", email: `nocid2-${crypto.randomUUID()}@example.test`, cid: null })
      .select("id")
      .single();
    expect(second.error).toBeNull();
    personIds.push(second.data!.id);
  });

  test("two different clubs can reuse the same eactivities_event_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const sharedEventId = `evt-${crypto.randomUUID()}`;

    const judoSession = await admin
      .from("session")
      .insert({ club_id: judo, title: "Judo session", starts_at: new Date().toISOString(), eactivities_event_id: sharedEventId })
      .select("id")
      .single();
    expect(judoSession.error).toBeNull();
    sessionIds.push(judoSession.data!.id);

    const tkdSession = await admin
      .from("session")
      .insert({ club_id: taekwondo, title: "Taekwondo session", starts_at: new Date().toISOString(), eactivities_event_id: sharedEventId })
      .select("id")
      .single();
    expect(tkdSession.error).toBeNull();
    sessionIds.push(tkdSession.data!.id);
  });

  test("two different clubs can reuse the same purchase source_row_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const sharedRowId = `row-${crypto.randomUUID()}`;

    const judoPurchase = await admin
      .from("purchase")
      .insert({ club_id: judo, source: "pluto_api", source_row_id: sharedRowId, purchased_at: new Date().toISOString() })
      .select("id")
      .single();
    expect(judoPurchase.error).toBeNull();
    purchaseIds.push(judoPurchase.data!.id);

    const tkdPurchase = await admin
      .from("purchase")
      .insert({ club_id: taekwondo, source: "pluto_api", source_row_id: sharedRowId, purchased_at: new Date().toISOString() })
      .select("id")
      .single();
    expect(tkdPurchase.error).toBeNull();
    purchaseIds.push(tkdPurchase.data!.id);
  });
});
