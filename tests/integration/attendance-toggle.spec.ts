import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

// Exercises the same upsert pattern toggleAttendance() uses
// (lib/attendance/actions.ts) directly against the DB, rather than calling
// toggleAttendance itself: that function calls requireAdmin() first, which
// needs a real Next.js request/cookie context this integration harness
// doesn't have (see tests/integration/chase-approval.spec.ts for the same
// split — auth-gated Server Actions aren't unit-testable directly, so the
// underlying write is verified instead). Task 3.2's verify items are about
// the UNIQUE(person_id, session_id) + upsert idempotency, which this covers.
const admin = createAdminClient();

async function toggle(personId: string, sessionId: string, attended: boolean) {
  const { error } = await admin.from("attendance_record").upsert(
    { person_id: personId, session_id: sessionId, attended, source: "manual_tick" },
    { onConflict: "person_id,session_id" }
  );
  if (error) throw error;
}

test.describe("attendance toggle idempotency (AC-2)", () => {
  let sessionId = "";
  let personId = "";

  test.beforeEach(async () => {
    const { data: person, error: personError } = await admin
      .from("person")
      .insert({
        full_name: "Toggle Test Person",
        email: `attendance-toggle-test-${crypto.randomUUID()}@example.test`,
      })
      .select("id")
      .single();
    if (personError) throw personError;
    personId = person.id;

    const { data: session, error: sessionError } = await admin
      .from("session")
      .insert({ title: "Toggle Test Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    if (sessionError) throw sessionError;
    sessionId = session.id;
  });

  test.afterEach(async () => {
    await admin.from("attendance_record").delete().eq("session_id", sessionId);
    await admin.from("session").delete().eq("id", sessionId);
    await admin.from("person").delete().eq("id", personId);
  });

  test("double-ticking the same person for the same session produces exactly one row", async () => {
    await toggle(personId, sessionId, true);
    await toggle(personId, sessionId, true);

    const { data, count } = await admin
      .from("attendance_record")
      .select("id, attended", { count: "exact" })
      .eq("person_id", personId)
      .eq("session_id", sessionId);

    expect(count).toBe(1);
    expect(data![0].attended).toBe(true);
  });

  test("un-ticking flips the same row to attended=false rather than deleting or duplicating it", async () => {
    await toggle(personId, sessionId, true);
    await toggle(personId, sessionId, false);

    const { data, count } = await admin
      .from("attendance_record")
      .select("id, attended", { count: "exact" })
      .eq("person_id", personId)
      .eq("session_id", sessionId);

    expect(count).toBe(1);
    expect(data![0].attended).toBe(false);
  });
});
