import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSessionFromCsvSchema, importAttendanceCsv } from "@/lib/csv-import/importer";
import { getSessionWithAttendance, listRecentSessions } from "@/lib/attendance/queries";
import { isInPrefetchWindow } from "@/lib/attendance/event-window";

const admin = createAdminClient();
const HOUR_MS = 60 * 60 * 1000;

let judoClubId: string;
test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});

const createdSessionIds: string[] = [];
const createdEmails: string[] = [];

test.afterEach(async () => {
  if (createdSessionIds.length > 0) {
    const { error: aErr } = await admin.from("attendance_record").delete().in("session_id", createdSessionIds);
    if (aErr) throw aErr;
    const { error: sErr } = await admin.from("session").delete().in("id", createdSessionIds);
    if (sErr) throw sErr;
    createdSessionIds.length = 0;
  }
  if (createdEmails.length > 0) {
    const { error: pErr } = await admin.from("person").delete().in("email", createdEmails);
    if (pErr) throw pErr;
    createdEmails.length = 0;
  }
});

function oneRow() {
  const email = `end-time-test-${crypto.randomUUID()}@example.test`;
  createdEmails.push(email);
  return { firstName: "End", surname: "Time", email, rawCidOrCardNumber: null };
}

async function readSession(id: string) {
  const { data, error } = await admin.from("session").select("starts_at, ends_at").eq("id", id).single();
  if (error) throw error;
  return data as { starts_at: string; ends_at: string | null };
}

test.describe("importAttendanceCsv end time", () => {
  test("stores ends_at when endsAt is given", async () => {
    const startsAt = new Date(Date.now() + 24 * HOUR_MS);
    const endsAt = new Date(startsAt.getTime() + 2 * HOUR_MS);
    const { sessionId } = await importAttendanceCsv(
      { title: "End Time Stored", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), rows: [oneRow()] },
      judoClubId
    );
    createdSessionIds.push(sessionId);
    const row = await readSession(sessionId);
    expect(new Date(row.ends_at!).getTime()).toBe(endsAt.getTime());
  });

  test("stores null ends_at when endsAt is omitted", async () => {
    const { sessionId } = await importAttendanceCsv(
      { title: "No End Time", startsAt: new Date(Date.now() + 24 * HOUR_MS).toISOString(), rows: [oneRow()] },
      judoClubId
    );
    createdSessionIds.push(sessionId);
    expect((await readSession(sessionId)).ends_at).toBeNull();
  });
});

test.describe("createSessionFromCsvSchema endsAt", () => {
  const startsAt = "2026-12-01T18:00:00.000Z";

  test("rejects endsAt equal to or before startsAt with a clear message", () => {
    for (const endsAt of [startsAt, "2026-12-01T17:00:00.000Z"]) {
      const result = createSessionFromCsvSchema.safeParse({ title: "T", startsAt, endsAt });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((i) => i.message).join(" ")).toContain("End time must be after the start time");
      }
    }
  });

  test("accepts a later endsAt, an omitted endsAt and an empty endsAt (as null)", () => {
    const ok = createSessionFromCsvSchema.safeParse({ title: "T", startsAt, endsAt: "2026-12-01T20:00:00.000Z" });
    expect(ok.success).toBe(true);
    const omitted = createSessionFromCsvSchema.safeParse({ title: "T", startsAt });
    expect(omitted.success).toBe(true);
    const empty = createSessionFromCsvSchema.safeParse({ title: "T", startsAt, endsAt: "" });
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.endsAt ?? null).toBeNull();
  });
});

test.describe("reads return endsAt and seriesId", () => {
  test("getSessionWithAttendance and listRecentSessions return a stored endsAt, null seriesId", async () => {
    const startsAt = new Date(Date.now() + 24 * HOUR_MS);
    const endsAt = new Date(startsAt.getTime() + 3 * HOUR_MS);
    const { data, error } = await admin
      .from("session")
      .insert({
        club_id: judoClubId,
        title: "Reads End Time",
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    createdSessionIds.push(data.id);

    const detail = await getSessionWithAttendance(data.id, judoClubId);
    expect(new Date(detail!.endsAt!).getTime()).toBe(endsAt.getTime());
    expect(detail!.seriesId).toBeNull();

    const list = await listRecentSessions(judoClubId);
    const item = list.find((s) => s.id === data.id)!;
    expect(new Date(item.endsAt!).getTime()).toBe(endsAt.getTime());
    expect(item.seriesId).toBeNull();
  });

  test("a legacy row without an end time reads back endsAt null", async () => {
    const { data, error } = await admin
      .from("session")
      .insert({ club_id: judoClubId, title: "Legacy No End", starts_at: new Date(Date.now() + 24 * HOUR_MS).toISOString() })
      .select("id")
      .single();
    if (error) throw error;
    createdSessionIds.push(data.id);

    const detail = await getSessionWithAttendance(data.id, judoClubId);
    expect(detail!.endsAt).toBeNull();
    expect(detail!.seriesId).toBeNull();
    const item = (await listRecentSessions(judoClubId)).find((s) => s.id === data.id)!;
    expect(item.endsAt).toBeNull();
    expect(item.seriesId).toBeNull();
  });
});

test.describe("prefetch window uses the stored end time", () => {
  test("a 3h session is in window at start + 3h30, a null-end session is not", async () => {
    const startsAt = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const { data, error } = await admin
      .from("session")
      .insert([
        {
          club_id: judoClubId,
          title: "Window With End",
          starts_at: startsAt.toISOString(),
          ends_at: new Date(startsAt.getTime() + 3 * HOUR_MS).toISOString(),
        },
        { club_id: judoClubId, title: "Window No End", starts_at: startsAt.toISOString() },
      ])
      .select("id, title");
    if (error) throw error;
    for (const r of data) createdSessionIds.push(r.id);

    const list = await listRecentSessions(judoClubId);
    const now = new Date(startsAt.getTime() + 3.5 * HOUR_MS);
    const inWindow = (title: string) => {
      const id = data.find((r) => r.title === title)!.id;
      const s = list.find((x) => x.id === id)!;
      return isInPrefetchWindow({
        startsAt: new Date(s.startsAt),
        endsAt: s.endsAt ? new Date(s.endsAt) : null,
        cancelledAt: null,
        now,
      });
    };
    expect(inWindow("Window With End")).toBe(true);
    expect(inWindow("Window No End")).toBe(false);
  });
});
