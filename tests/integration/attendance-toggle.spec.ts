import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

// Exercises the real toggle_attendance RPC directly (lib/attendance/
// actions.ts's toggleAttendance calls this same function) rather than the
// Server Action itself: that function calls requireAdmin() first, which
// needs a real Next.js request/cookie context this integration harness
// doesn't have (see tests/integration/chase-approval.spec.ts for the same
// split — auth-gated Server Actions aren't unit-testable directly, so the
// underlying write is verified instead).
const admin = createAdminClient();

async function toggle(personId: string, sessionId: string, attended: boolean) {
  const { error } = await admin.rpc("toggle_attendance", {
    target_person_id: personId,
    target_session_id: sessionId,
    target_attended: attended,
  });
  if (error) throw error;
}

test.describe("toggle_attendance (AC-2)", () => {
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

  test("ticking an existing csv_import row preserves its source instead of overwriting it to manual_tick", async () => {
    const { error } = await admin
      .from("attendance_record")
      .insert({ person_id: personId, session_id: sessionId, attended: false, source: "csv_import" });
    if (error) throw error;

    await toggle(personId, sessionId, true);

    const { data } = await admin
      .from("attendance_record")
      .select("source, attended")
      .eq("person_id", personId)
      .eq("session_id", sessionId)
      .single();
    expect(data!.source).toBe("csv_import");
    expect(data!.attended).toBe(true);
  });

  test("a brand-new row from toggling gets source manual_tick", async () => {
    await toggle(personId, sessionId, true);

    const { data } = await admin
      .from("attendance_record")
      .select("source")
      .eq("person_id", personId)
      .eq("session_id", sessionId)
      .single();
    expect(data!.source).toBe("manual_tick");
  });

  test("two concurrent ticks of a not-yet-existing row never throw a duplicate-key error and leave exactly one row", async () => {
    // Simulates two admins both tapping "add" for the same not-yet-on-
    // the-roster person (e.g. a walk-in) at the same instant -- the old
    // SELECT-then-branch implementation could have both branches see "no
    // row" and both attempt an INSERT, with the loser throwing a
    // duplicate-key error. The atomic INSERT ... ON CONFLICT DO UPDATE
    // has no such window.
    await Promise.all([
      toggle(personId, sessionId, true),
      toggle(personId, sessionId, true),
    ]);

    const { data, count } = await admin
      .from("attendance_record")
      .select("id, attended, source", { count: "exact" })
      .eq("person_id", personId)
      .eq("session_id", sessionId);

    expect(count).toBe(1);
    expect(data![0].attended).toBe(true);
    expect(data![0].source).toBe("manual_tick");
  });
});
