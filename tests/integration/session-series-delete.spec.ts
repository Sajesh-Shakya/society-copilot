import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { planSeriesDelete, executeSeriesDelete } from "@/lib/session-series/delete";

const admin = createAdminClient();

let judoClubId: string;
let taekwondoClubId: string;
test.beforeAll(async () => {
  const { data: judo, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = judo.id;
  const { data: tkd, error: tkdError } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  if (tkdError) throw tkdError;
  taekwondoClubId = tkd.id;
});

const DAY = 24 * 60 * 60 * 1000;

test.describe("series delete", () => {
  let seriesIds: string[] = [];
  let personIds: string[] = [];

  test.afterEach(async () => {
    for (const seriesId of seriesIds) {
      const { data: sessions } = await admin.from("session").select("id").eq("series_id", seriesId);
      const ids = (sessions ?? []).map((s) => s.id);
      for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100);
        await admin.from("attendance_record").delete().in("session_id", part);
        await admin.from("session").delete().in("id", part);
      }
      await admin.from("session_series").delete().eq("id", seriesId);
    }
    if (personIds.length > 0) await admin.from("person").delete().in("id", personIds);
    seriesIds = [];
    personIds = [];
  });

  /** Direct-insert a weekly series of `count` sessions starting `firstOffsetDays` from now. */
  async function makeSeries(clubId: string, count: number, firstOffsetDays = -14) {
    const title = `Series Delete ${crypto.randomUUID()}`;
    const { data: series, error } = await admin.from("session_series").insert({ club_id: clubId, title }).select("id").single();
    if (error) throw error;
    seriesIds.push(series.id);
    const base = Date.now() + firstOffsetDays * DAY;
    const { data: sessions, error: sError } = await admin
      .from("session")
      .insert(
        Array.from({ length: count }, (_, i) => ({
          club_id: clubId,
          title,
          starts_at: new Date(base + i * 7 * DAY).toISOString(),
          series_id: series.id,
        }))
      )
      .select("id, starts_at");
    if (sError) throw sError;
    const ids = sessions!
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
      .map((s) => s.id);
    return { seriesId: series.id as string, title, ids };
  }

  async function makePerson(clubId: string): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({
        club_id: clubId,
        full_name: "Series Delete Person",
        email: `series-delete-${crypto.randomUUID()}@example.test`,
        is_exempt: false,
      })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(data.id);
    return data.id;
  }

  async function addRecord(clubId: string, sessionId: string, personId: string, attended: boolean) {
    const { error } = await admin
      .from("attendance_record")
      .insert({ club_id: clubId, session_id: sessionId, person_id: personId, attended, source: attended ? "manual_tick" : "csv_import" });
    if (error) throw error;
  }

  async function existingSessionIds(ids: string[]): Promise<string[]> {
    const { data } = await admin.from("session").select("id").in("id", ids);
    return (data ?? []).map((s) => s.id);
  }

  async function seriesRowExists(seriesId: string): Promise<boolean> {
    const { count } = await admin.from("session_series").select("id", { count: "exact", head: true }).eq("id", seriesId);
    return count === 1;
  }

  test("(a) from occurrence 3 only 3-5 are targeted and earlier ones survive", async () => {
    const { ids } = await makeSeries(judoClubId, 5);
    const plan = await planSeriesDelete(ids[2], judoClubId);
    expect(plan!.toDelete.map((s) => s.id)).toEqual(ids.slice(2));
    expect(plan!.kept).toEqual([]);

    const result = await executeSeriesDelete(ids[2], judoClubId);
    expect(result).toEqual({ deleted: 3, kept: 0 });
    expect((await existingSessionIds(ids)).sort()).toEqual(ids.slice(0, 2).sort());
  });

  test("(b) an attended record keeps that occurrence, others deleted, series row remains", async () => {
    const { seriesId, ids } = await makeSeries(judoClubId, 5);
    const p1 = await makePerson(judoClubId);
    const p2 = await makePerson(judoClubId);
    const p3 = await makePerson(judoClubId);
    await addRecord(judoClubId, ids[3], p1, true);
    await addRecord(judoClubId, ids[3], p2, true);
    await addRecord(judoClubId, ids[3], p3, false);

    const plan = await planSeriesDelete(ids[2], judoClubId);
    expect(plan!.seriesId).toBe(seriesId);
    expect(plan!.toDelete.map((s) => s.id)).toEqual([ids[2], ids[4]]);
    expect(plan!.kept).toHaveLength(1);
    expect(plan!.kept[0]).toMatchObject({ id: ids[3], attendedCount: 2 });

    const result = await executeSeriesDelete(ids[2], judoClubId);
    expect(result).toEqual({ deleted: 2, kept: 1 });
    expect((await existingSessionIds(ids)).sort()).toEqual([ids[0], ids[1], ids[3]].sort());
    expect(await seriesRowExists(seriesId)).toBe(true);
    // The kept session's records are untouched, including the unattended one.
    const { count } = await admin.from("attendance_record").select("id", { count: "exact", head: true }).eq("session_id", ids[3]);
    expect(count).toBe(3);
  });

  test("(c) a future occurrence with an attended record is kept too", async () => {
    const { ids } = await makeSeries(judoClubId, 4, 7);
    const p = await makePerson(judoClubId);
    await addRecord(judoClubId, ids[2], p, true);
    const result = await executeSeriesDelete(ids[0], judoClubId);
    expect(result).toEqual({ deleted: 3, kept: 1 });
    expect(await existingSessionIds(ids)).toEqual([ids[2]]);
  });

  test("(d) an occurrence with only attended=false roster rows is deleted with those rows", async () => {
    const { seriesId, ids } = await makeSeries(judoClubId, 3);
    const p = await makePerson(judoClubId);
    await addRecord(judoClubId, ids[1], p, false);
    const result = await executeSeriesDelete(ids[0], judoClubId);
    expect(result).toEqual({ deleted: 3, kept: 0 });
    expect(await existingSessionIds(ids)).toEqual([]);
    const { count } = await admin.from("attendance_record").select("id", { count: "exact", head: true }).eq("session_id", ids[1]);
    expect(count).toBe(0);
    expect(await seriesRowExists(seriesId)).toBe(false);
  });

  test("(e) deleting from occurrence 1 with nothing attended removes sessions and the series row", async () => {
    const { seriesId, ids } = await makeSeries(judoClubId, 5);
    const result = await executeSeriesDelete(ids[0], judoClubId);
    expect(result).toEqual({ deleted: 5, kept: 0 });
    expect(await existingSessionIds(ids)).toEqual([]);
    expect(await seriesRowExists(seriesId)).toBe(false);
  });

  test("(f) a non-series session: plan is null and nothing is deleted", async () => {
    const { data: s, error } = await admin
      .from("session")
      .insert({ club_id: judoClubId, title: `Series Delete solo ${crypto.randomUUID()}`, starts_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw error;
    try {
      expect(await planSeriesDelete(s.id, judoClubId)).toBeNull();
      expect(await executeSeriesDelete(s.id, judoClubId)).toEqual({ deleted: 0, kept: 0 });
      expect(await existingSessionIds([s.id])).toEqual([s.id]);
    } finally {
      await admin.from("session").delete().eq("id", s.id);
    }
  });

  test("(g) cross-club: a session of club B with club A's id plans null and deletes nothing", async () => {
    const { seriesId, ids } = await makeSeries(taekwondoClubId, 3);
    expect(await planSeriesDelete(ids[0], judoClubId)).toBeNull();
    expect(await executeSeriesDelete(ids[0], judoClubId)).toEqual({ deleted: 0, kept: 0 });
    expect((await existingSessionIds(ids)).sort()).toEqual([...ids].sort());
    expect(await seriesRowExists(seriesId)).toBe(true);
  });

  test("(h) a full 60-occurrence series is deleted in one call", async () => {
    const { seriesId, ids } = await makeSeries(judoClubId, 60);
    const p = await makePerson(judoClubId);
    await addRecord(judoClubId, ids[10], p, false);
    const result = await executeSeriesDelete(ids[0], judoClubId);
    expect(result).toEqual({ deleted: 60, kept: 0 });
    expect(await existingSessionIds(ids)).toEqual([]);
    expect(await seriesRowExists(seriesId)).toBe(false);
  });

  test("(i) the database itself refuses to delete a session that has attendance rows (backstop for the plan/execute race)", async () => {
    const { ids } = await makeSeries(judoClubId, 2);
    const p = await makePerson(judoClubId);
    await addRecord(judoClubId, ids[0], p, true);
    const { error } = await admin.from("session").delete().eq("id", ids[0]);
    expect(error).toBeTruthy();
    expect(await existingSessionIds([ids[0]])).toEqual([ids[0]]);
  });
});
