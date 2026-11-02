import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("createClubScopedClient", () => {
  let personIds: string[] = [];
  let productIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) await admin.from("person").delete().in("id", personIds);
    personIds = [];
    if (productIds.length) await admin.from("product").delete().in("id", productIds);
    productIds = [];
  });

  test("select automatically filters by club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const email = `scoped-select-${crypto.randomUUID()}@example.test`;

    const inserted = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Judo Person", email })
      .select("id")
      .single();
    personIds.push(inserted.data!.id);

    const scopedAsTaekwondo = createClubScopedClient(taekwondo);
    const { data } = await scopedAsTaekwondo.from("person").select("id").eq("email", email);
    expect(data).toEqual([]);

    const scopedAsJudo = createClubScopedClient(judo);
    const { data: found } = await scopedAsJudo.from("person").select("id").eq("email", email);
    expect(found).toHaveLength(1);
  });

  test("insert stamps club_id automatically, without the caller supplying it", async () => {
    const judo = await clubId("judo");
    const scoped = createClubScopedClient(judo);
    const email = `scoped-insert-${crypto.randomUUID()}@example.test`;

    const { data, error } = await scoped
      .from("person")
      .insert({ full_name: "Stamped", email })
      .select("id")
      .single();
    expect(error).toBeNull();
    personIds.push(data!.id);

    const { data: row } = await admin.from("person").select("club_id").eq("id", data!.id).single();
    expect(row!.club_id).toBe(judo);
  });

  test("insert throws if the caller explicitly passes a different club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const scoped = createClubScopedClient(judo);

    expect(() =>
      scoped.from("person").insert({ club_id: taekwondo, full_name: "X", email: `x-${crypto.randomUUID()}@example.test` })
    ).toThrow();
  });

  test("update is scoped to the caller's club and cannot change club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const email = `scoped-update-${crypto.randomUUID()}@example.test`;

    const inserted = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Before", email })
      .select("id")
      .single();
    personIds.push(inserted.data!.id);

    // A Taekwondo-scoped client updating a Judo row's id affects zero rows.
    const scopedAsTaekwondo = createClubScopedClient(taekwondo);
    await scopedAsTaekwondo.from("person").update({ full_name: "Hacked" }).eq("id", inserted.data!.id);
    const { data: unchanged } = await admin.from("person").select("full_name").eq("id", inserted.data!.id).single();
    expect(unchanged!.full_name).toBe("Before");

    // Trying to move the row to another club is rejected outright.
    const scopedAsJudo = createClubScopedClient(judo);
    expect(() => scopedAsJudo.from("person").update({ club_id: taekwondo })).toThrow();
  });

  test("upsert rejects an onConflict target that omits club_id (DO UPDATE could hit another club's row)", async () => {
    const judo = await clubId("judo");
    const scoped = createClubScopedClient(judo);

    // product's conflict target is the global unique(name) constraint, which
    // doesn't include club_id -- a DO UPDATE on it could silently move
    // another club's product into this one.
    expect(() =>
      scoped.from("product").upsert({ name: `Dup-${crypto.randomUUID()}`, kind: "other" }, { onConflict: "name" })
    ).toThrow();
  });

  test("upsert with onConflict missing club_id does NOT throw when ignoreDuplicates is true", async () => {
    const judo = await clubId("judo");
    const scoped = createClubScopedClient(judo);
    const name = `Pass-${crypto.randomUUID()}`;

    expect(() =>
      scoped.from("product").upsert({ name, kind: "other" }, { onConflict: "name", ignoreDuplicates: true })
    ).not.toThrow();

    const { data, error } = await scoped
      .from("product")
      .upsert({ name, kind: "other" }, { onConflict: "club_id,name", ignoreDuplicates: true })
      .select("id");
    expect(error).toBeNull();

    const { data: row } = await admin.from("product").select("id, club_id").eq("name", name).single();
    expect(row!.club_id).toBe(judo);
    productIds.push(row!.id);
    if (data?.[0]?.id) productIds.push(data[0].id);
  });
});
