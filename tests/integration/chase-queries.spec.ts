import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { countFailedChaseEmails } from "@/lib/chase/queries";

const admin = createAdminClient();

async function createPerson() {
  const email = `chase-queries-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Chase Queries Test Person", email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createChaseEmail(personId: string, status: string) {
  const { data, error } = await admin
    .from("chase_email")
    .insert({
      person_id: personId,
      debt_cycle_started_at: new Date().toISOString(),
      sequence_number: 1,
      status,
      subject: "test",
      body: "test",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("countFailedChaseEmails", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("counts only failed rows, not other statuses", async () => {
    const before = await countFailedChaseEmails();

    personId = await createPerson();
    await createChaseEmail(personId, "failed");
    await createChaseEmail(personId, "sent");
    await createChaseEmail(personId, "approved");

    const after = await countFailedChaseEmails();
    expect(after).toBe(before + 1);
  });
});
