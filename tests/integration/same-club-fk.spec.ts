import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("same-club foreign keys", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length) await admin.from("attendance_record").delete().in("person_id", personIds);
    if (personIds.length) await admin.from("person").delete().in("id", personIds);
    if (sessionIds.length) await admin.from("session").delete().in("id", sessionIds);
    personIds = [];
    sessionIds = [];
  });

  test("an attendance_record cannot reference a person from a different club than its own club_id", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");

    const person = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Judo Person", email: `fk-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    personIds.push(person.data!.id);

    const session = await admin
      .from("session")
      .insert({ club_id: taekwondo, title: "Taekwondo Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    sessionIds.push(session.data!.id);

    // attendance_record claims club_id = taekwondo (matching the session),
    // but person_id belongs to judo -- the composite FK on
    // (person_id, club_id) -> person(id, club_id) must reject this, since
    // no person row exists with (id = person.data.id, club_id = taekwondo).
    const { error } = await admin.from("attendance_record").insert({
      club_id: taekwondo,
      person_id: person.data!.id,
      session_id: session.data!.id,
      source: "manual_tick",
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503"); // foreign_key_violation
  });

  test("an attendance_record CAN reference a person and session from the same club", async () => {
    const judo = await clubId("judo");

    const person = await admin
      .from("person")
      .insert({ club_id: judo, full_name: "Judo Person 2", email: `fk-ok-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    personIds.push(person.data!.id);

    const session = await admin
      .from("session")
      .insert({ club_id: judo, title: "Judo Session", starts_at: new Date().toISOString() })
      .select("id")
      .single();
    sessionIds.push(session.data!.id);

    const { error } = await admin.from("attendance_record").insert({
      club_id: judo,
      person_id: person.data!.id,
      session_id: session.data!.id,
      source: "manual_tick",
    });
    expect(error).toBeNull();
  });
});
