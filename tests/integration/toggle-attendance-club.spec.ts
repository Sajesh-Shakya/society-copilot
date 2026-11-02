import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

test.describe("toggle_attendance derives club from session", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) {
      await admin.from("attendance_record").delete().in("person_id", personIds);
      await admin.from("person").delete().in("id", personIds);
    }
    if (sessionIds.length) await admin.from("session").delete().in("id", sessionIds);
    personIds = [];
    sessionIds = [];
  });

  test("toggling attendance for a Taekwondo session stamps the Taekwondo club_id, not Judo's", async () => {
    const { data: taekwondo } = await admin.from("club").select("id").eq("slug", "taekwondo").single();

    const person = await admin
      .from("person")
      .insert({
        club_id: taekwondo!.id,
        full_name: "Taekwondo Person",
        email: `tkd-toggle-${crypto.randomUUID()}@example.test`,
      })
      .select("id")
      .single();
    personIds.push(person.data!.id);

    const session = await admin
      .from("session")
      .insert({ club_id: taekwondo!.id, title: "Taekwondo Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    sessionIds.push(session.data!.id);

    const { error } = await admin.rpc("toggle_attendance", {
      target_person_id: person.data!.id,
      target_session_id: session.data!.id,
      target_attended: true,
    });
    expect(error).toBeNull();

    const { data: record } = await admin
      .from("attendance_record")
      .select("club_id")
      .eq("person_id", person.data!.id)
      .eq("session_id", session.data!.id)
      .single();
    expect(record!.club_id).toBe(taekwondo!.id);
  });
});
