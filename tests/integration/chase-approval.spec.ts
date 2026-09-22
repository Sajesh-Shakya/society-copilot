import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { approveChaseEmail, rejectChaseEmail } from "@/lib/chase/approval-writer";

const TEST_ADMIN_EMAIL = "test-admin@example.test";
const admin = createAdminClient();

async function createPerson() {
  const email = `chase-approval-test-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: "Chase Approval Test Person", email, is_exempt: false })
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

test.describe("approveChaseEmail", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("approves a pending_approval row and records approved_by/approved_at", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "pending_approval");

    const result = await approveChaseEmail(chaseEmailId, TEST_ADMIN_EMAIL);
    expect(result.approved).toBe(true);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, approved_by, approved_at")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("approved");
    expect(row.approved_by).toBe(TEST_ADMIN_EMAIL);
    expect(row.approved_at).not.toBeNull();
  });

  test("is a no-op on a row that is not pending_approval", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "sent");

    const result = await approveChaseEmail(chaseEmailId, TEST_ADMIN_EMAIL);
    expect(result.approved).toBe(false);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, approved_by")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("sent"); // untouched
    expect(row.approved_by).toBeNull();
  });
});

test.describe("rejectChaseEmail", () => {
  let personId = "";

  test.afterEach(async () => {
    if (!personId) return;
    const { error: chaseError } = await admin.from("chase_email").delete().eq("person_id", personId);
    if (chaseError) throw chaseError;
    const { error: personError } = await admin.from("person").delete().eq("id", personId);
    if (personError) throw personError;
    personId = "";
  });

  test("rejects a pending_approval row and preserves the reviewer's note", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "pending_approval");

    const result = await rejectChaseEmail(chaseEmailId, "Wrong person, they already paid in cash.", TEST_ADMIN_EMAIL);
    expect(result.rejected).toBe(true);

    const { data: row, error } = await admin
      .from("chase_email")
      .select("status, note")
      .eq("id", chaseEmailId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("cancelled");
    expect(row.note).toContain("Wrong person, they already paid in cash.");
    expect(row.note).toContain(TEST_ADMIN_EMAIL);
  });

  test("rejects an approved (not yet sent) row too", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "approved");

    const result = await rejectChaseEmail(chaseEmailId, "Duplicate draft.", TEST_ADMIN_EMAIL);
    expect(result.rejected).toBe(true);

    const { data: row, error } = await admin.from("chase_email").select("status").eq("id", chaseEmailId).single();
    if (error) throw error;
    expect(row.status).toBe("cancelled");
  });

  test("is a no-op on a row that is already sent", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "sent");

    const result = await rejectChaseEmail(chaseEmailId, "too late", TEST_ADMIN_EMAIL);
    expect(result.rejected).toBe(false);

    const { data: row, error } = await admin.from("chase_email").select("status, note").eq("id", chaseEmailId).single();
    if (error) throw error;
    expect(row.status).toBe("sent"); // untouched
    expect(row.note).toBeNull();
  });

  test("rejects the empty-string note as invalid input", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "pending_approval");

    await expect(rejectChaseEmail(chaseEmailId, "", TEST_ADMIN_EMAIL)).rejects.toThrow();
  });

  test("rejects a whitespace-only note as invalid input", async () => {
    personId = await createPerson();
    const chaseEmailId = await createChaseEmail(personId, "pending_approval");

    await expect(rejectChaseEmail(chaseEmailId, "   ", TEST_ADMIN_EMAIL)).rejects.toThrow();
  });
});
