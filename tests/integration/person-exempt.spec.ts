import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyPersonExempt } from "@/lib/person/exempt-writer";

const TEST_ADMIN_EMAIL = "test-admin@example.test";

const admin = createAdminClient();

let judoClubId: string;
test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});

async function createPerson() {
  const email = `exempt-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ club_id: judoClubId, full_name: "Exempt Test Person", email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("setPersonExempt", () => {
  let personId = "";
  let tkdPersonId = "";

  test.afterEach(async () => {
    if (!personId) {
      if (!tkdPersonId) return;
      const { error } = await admin.from("person").delete().eq("id", tkdPersonId);
      if (error) throw error;
      tkdPersonId = "";
      return;
    }
    const { error } = await admin.from("person").delete().eq("id", personId);
    if (error) throw error;
    personId = "";
  });

  test("setting exempt=true with a reason records set_by/set_at/reason", async () => {
    personId = await createPerson();
    await applyPersonExempt({ personId, exempt: true, reason: "Committee member" }, judoClubId, TEST_ADMIN_EMAIL);

    const { data: row, error } = await admin
      .from("person")
      .select("is_exempt, exempt_set_by, exempt_set_at, exempt_reason")
      .eq("id", personId)
      .single();
    if (error) throw error;

    expect(row.is_exempt).toBe(true);
    expect(row.exempt_set_by).toBe(TEST_ADMIN_EMAIL);
    expect(row.exempt_set_at).not.toBeNull();
    expect(row.exempt_reason).toBe("Committee member");
  });

  test("setting exempt=true without a reason leaves exempt_reason null", async () => {
    personId = await createPerson();
    await applyPersonExempt({ personId, exempt: true }, judoClubId, TEST_ADMIN_EMAIL);

    const { data: row, error } = await admin
      .from("person")
      .select("is_exempt, exempt_reason")
      .eq("id", personId)
      .single();
    if (error) throw error;

    expect(row.is_exempt).toBe(true);
    expect(row.exempt_reason).toBeNull();
  });

  test("clearing exempt=false resets set_by/set_at/reason to null", async () => {
    personId = await createPerson();
    await applyPersonExempt({ personId, exempt: true, reason: "temp" }, judoClubId, TEST_ADMIN_EMAIL);
    await applyPersonExempt({ personId, exempt: false }, judoClubId, TEST_ADMIN_EMAIL);

    const { data: row, error } = await admin
      .from("person")
      .select("is_exempt, exempt_set_by, exempt_set_at, exempt_reason")
      .eq("id", personId)
      .single();
    if (error) throw error;

    expect(row.is_exempt).toBe(false);
    expect(row.exempt_set_by).toBeNull();
    expect(row.exempt_set_at).toBeNull();
    expect(row.exempt_reason).toBeNull();
  });

  test("refuses to update a person who belongs to a different club", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const { data: tkdPerson, error } = await admin
      .from("person")
      .insert({ club_id: taekwondo!.id, full_name: "Taekwondo Exempt Test", email: `tkd-exempt-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    if (error) throw error;
    tkdPersonId = tkdPerson!.id;

    await expect(
      applyPersonExempt({ personId: tkdPerson!.id, exempt: true }, judoClubId, TEST_ADMIN_EMAIL)
    ).rejects.toThrow();
  });
});
