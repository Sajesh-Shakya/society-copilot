import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyPersonExempt } from "@/lib/person/actions";

const TEST_ADMIN_EMAIL = "test-admin@example.test";

const admin = createAdminClient();

async function createPerson() {
  const email = `exempt-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Exempt Test Person", email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("setPersonExempt", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error } = await admin.from("person").delete().eq("id", personId);
    if (error) throw error;
    personId = "";
  });

  test("setting exempt=true with a reason records set_by/set_at/reason", async () => {
    personId = await createPerson();
    await applyPersonExempt({ personId, exempt: true, reason: "Committee member" }, TEST_ADMIN_EMAIL);

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
    await applyPersonExempt({ personId, exempt: true }, TEST_ADMIN_EMAIL);

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
    await applyPersonExempt({ personId, exempt: true, reason: "temp" }, TEST_ADMIN_EMAIL);
    await applyPersonExempt({ personId, exempt: false }, TEST_ADMIN_EMAIL);

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
});
