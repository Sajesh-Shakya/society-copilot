import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("session end time and series schema", () => {
  let sessionIds: string[] = [];
  let seriesIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
    }
    if (seriesIds.length) await admin.from("session_series").delete().in("id", seriesIds);
    sessionIds = [];
    seriesIds = [];
  });

  async function makeSeries(club: string, title = "Series") {
    const { data, error } = await admin
      .from("session_series")
      .insert({ club_id: club, title })
      .select("id")
      .single();
    if (error) throw error;
    seriesIds.push(data.id);
    return data.id as string;
  }

  async function insertSession(club: string, startsAt: Date, extra: Record<string, unknown> = {}) {
    const res = await admin
      .from("session")
      .insert({ club_id: club, title: "Schema Test", starts_at: startsAt.toISOString(), ...extra })
      .select("id")
      .single();
    if (res.data) sessionIds.push(res.data.id);
    return res;
  }

  test("ends_at must be strictly after starts_at; null is allowed", async () => {
    const judo = await clubId("judo");
    const start = new Date("2030-01-01T18:00:00Z");

    const earlier = await insertSession(judo, start, { ends_at: "2030-01-01T17:00:00Z" });
    expect(earlier.error).not.toBeNull();
    expect(earlier.error!.code).toBe("23514"); // check_violation

    const equal = await insertSession(judo, start, { ends_at: start.toISOString() });
    expect(equal.error).not.toBeNull();
    expect(equal.error!.code).toBe("23514");

    const later = await insertSession(judo, start, { ends_at: "2030-01-01T19:00:00Z" });
    expect(later.error).toBeNull();

    const none = await insertSession(judo, start, { ends_at: null });
    expect(none.error).toBeNull();
  });

  test("a session cannot reference a series from a different club", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const taekwondoSeries = await makeSeries(taekwondo);

    const res = await insertSession(judo, new Date("2030-01-01T18:00:00Z"), {
      series_id: taekwondoSeries,
    });
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe("23503"); // foreign_key_violation
  });

  test("a session CAN reference a series from the same club", async () => {
    const judo = await clubId("judo");
    const series = await makeSeries(judo);
    const res = await insertSession(judo, new Date("2030-01-01T18:00:00Z"), { series_id: series });
    expect(res.error).toBeNull();
  });

  test("deleting a series that still has sessions fails", async () => {
    const judo = await clubId("judo");
    const series = await makeSeries(judo);
    const created = await insertSession(judo, new Date("2030-01-01T18:00:00Z"), { series_id: series });
    expect(created.error).toBeNull();

    const del = await admin.from("session_series").delete().eq("id", series);
    expect(del.error).not.toBeNull();
    expect(del.error!.code).toBe("23503");
  });

  test("the club-scoped client stamps club_id on session_series and scopes reads", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");

    const { data, error } = await createClubScopedClient(judo)
      .from("session_series")
      .insert({ title: "Scoped Series" })
      .select("id, club_id")
      .single();
    expect(error).toBeNull();
    seriesIds.push(data!.id);
    expect(data!.club_id).toBe(judo);

    const own = await createClubScopedClient(judo).from("session_series").select("id").eq("id", data!.id);
    expect(own.data).toHaveLength(1);

    const other = await createClubScopedClient(taekwondo)
      .from("session_series")
      .select("id")
      .eq("id", data!.id);
    expect(other.error).toBeNull();
    expect(other.data).toHaveLength(0);
  });
});
