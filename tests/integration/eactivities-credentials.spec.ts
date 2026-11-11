import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEactivitiesCredentials } from "@/lib/eactivities/credentials";
import { EactivitiesNotConfiguredError } from "@/lib/eactivities/types";

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

test.describe("getEactivitiesCredentials", () => {
  let insertedClubIds: string[] = [];

  test.afterEach(async () => {
    if (insertedClubIds.length === 0) return;
    const { error } = await admin.from("club_credential").delete().in("club_id", insertedClubIds).eq("provider", "eactivities");
    if (error) throw error;
    insertedClubIds = [];
  });

  test("returns the stored apiKey/cspCode for a club with a credential row", async () => {
    const { error } = await admin.from("club_credential").insert({
      club_id: taekwondoClubId,
      provider: "eactivities",
      credentials: { apiKey: "test-api-key-123", cspCode: "test-csp-456" },
    });
    if (error) throw error;
    insertedClubIds.push(taekwondoClubId);

    const result = await getEactivitiesCredentials(taekwondoClubId);
    expect(result).toEqual({ apiKey: "test-api-key-123", cspCode: "test-csp-456" });
  });

  test("throws EactivitiesNotConfiguredError when no row exists for the club", async () => {
    // Judo now has a real club_credential row (migrated as part of this
    // plan's Task 5) -- Taekwondo is the club guaranteed to have none,
    // since every test in this file that inserts a row for it cleans up
    // via the shared afterEach above. Guarded explicitly rather than just
    // assumed: if Taekwondo is ever provisioned for real, this test
    // should fail loudly here, not attempt a real insert and collide on
    // the (club_id, provider) primary key.
    const { data: existingTkdRow } = await admin
      .from("club_credential")
      .select("club_id")
      .eq("club_id", taekwondoClubId)
      .eq("provider", "eactivities")
      .maybeSingle();
    expect(existingTkdRow).toBeNull();

    await expect(getEactivitiesCredentials(taekwondoClubId)).rejects.toThrow(EactivitiesNotConfiguredError);
  });

  test("throws when the stored credentials are missing cspCode", async () => {
    const { error } = await admin.from("club_credential").insert({
      club_id: taekwondoClubId,
      provider: "eactivities",
      credentials: { apiKey: "test-api-key-only" },
    });
    if (error) throw error;
    insertedClubIds.push(taekwondoClubId);

    await expect(getEactivitiesCredentials(taekwondoClubId)).rejects.toThrow(EactivitiesNotConfiguredError);
  });

  test("throws when the stored credentials are missing apiKey", async () => {
    const { error } = await admin.from("club_credential").insert({
      club_id: taekwondoClubId,
      provider: "eactivities",
      credentials: { cspCode: "test-csp-only" },
    });
    if (error) throw error;
    insertedClubIds.push(taekwondoClubId);

    await expect(getEactivitiesCredentials(taekwondoClubId)).rejects.toThrow(EactivitiesNotConfiguredError);
  });
});
