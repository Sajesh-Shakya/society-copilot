import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createRecurringSeries } from "@/lib/session-series/create";
import { RecurrenceError } from "@/lib/session-series/recurrence";
import { listRecentSessions } from "@/lib/attendance/queries";
import type { AttendeeRow } from "@/lib/csv-import/parser";

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

function row(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    firstName: "Series",
    surname: "Test",
    email: `series-test-${crypto.randomUUID()}@example.test`,
    rawCidOrCardNumber: null,
    ...overrides,
  };
}

// Crosses the 25 Oct 2026 BST -> GMT change: 18 Oct (BST), 25 Oct, 1 Nov (GMT).
const crossing = (title: string) => ({
  title,
  firstDate: "2026-10-18",
  startTime: "19:00",
  endTime: "21:00",
  untilDate: "2026-11-01",
});

test.describe("createRecurringSeries", () => {
  let titles: string[] = [];
  let personEmails: string[] = [];
  let seriesIds: string[] = [];

  test.afterEach(async () => {
    for (const title of titles) {
      const { data: sessions } = await admin.from("session").select("id, series_id").eq("title", title);
      const ids = (sessions ?? []).map((s) => s.id);
      if (ids.length > 0) {
        await admin.from("attendance_record").delete().in("session_id", ids);
        await admin.from("session").delete().in("id", ids);
      }
      await admin.from("session_series").delete().eq("title", title);
    }
    if (seriesIds.length > 0) await admin.from("session_series").delete().in("id", seriesIds);
    if (personEmails.length > 0) await admin.from("person").delete().in("email", personEmails);
    titles = [];
    personEmails = [];
    seriesIds = [];
  });

  function newTitle(): string {
    const t = `Series Test ${crypto.randomUUID()}`;
    titles.push(t);
    return t;
  }

  test("(a) creates one session per week, same series_id, club, UTC instants, ends_at, no eActivities ids", async () => {
    const title = newTitle();
    const result = await createRecurringSeries(crossing(title), judoClubId);
    expect(result.sessionIds).toHaveLength(3);
    expect(result.imported).toBe(0);

    const { data: series } = await admin.from("session_series").select("club_id, title").eq("id", result.seriesId).single();
    expect(series!.club_id).toBe(judoClubId);
    expect(series!.title).toBe(title);

    const { data: sessions } = await admin
      .from("session")
      .select("id, club_id, title, starts_at, ends_at, series_id, eactivities_event_id, eactivities_signup_id")
      .eq("series_id", result.seriesId)
      .order("starts_at");
    expect(sessions).toHaveLength(3);
    expect(sessions!.map((s) => s.id)).toEqual(result.sessionIds);
    expect(sessions!.map((s) => new Date(s.starts_at).toISOString())).toEqual([
      "2026-10-18T18:00:00.000Z",
      "2026-10-25T19:00:00.000Z",
      "2026-11-01T19:00:00.000Z",
    ]);
    expect(sessions!.map((s) => new Date(s.ends_at!).toISOString())).toEqual([
      "2026-10-18T20:00:00.000Z",
      "2026-10-25T21:00:00.000Z",
      "2026-11-01T21:00:00.000Z",
    ]);
    for (const s of sessions!) {
      expect(s.club_id).toBe(judoClubId);
      expect(s.title).toBe(title);
      expect(s.eactivities_event_id).toBeNull();
      expect(s.eactivities_signup_id).toBeNull();
    }
  });

  test("(b) rows are applied to the first occurrence only", async () => {
    const title = newTitle();
    const rows = [row(), row()];
    personEmails.push(...rows.map((r) => r.email));
    const result = await createRecurringSeries({ ...crossing(title), rows }, judoClubId);
    expect(result.imported).toBe(2);

    const { data: records } = await admin
      .from("attendance_record")
      .select("session_id, source, attended")
      .in("session_id", result.sessionIds);
    const first = records!.filter((r) => r.session_id === result.sessionIds[0]);
    expect(first).toHaveLength(2);
    for (const r of first) {
      expect(r.source).toBe("csv_import");
      expect(r.attended).toBe(false);
    }
    expect(records!.filter((r) => r.session_id !== result.sessionIds[0])).toHaveLength(0);
  });

  test("(c) invalid recurrence throws RecurrenceError and writes nothing", async () => {
    const cases: Array<Partial<ReturnType<typeof crossing>>> = [
      { endTime: "19:00" },
      { endTime: "18:00" },
      { untilDate: "2026-10-11" },
      { untilDate: "2028-01-01" }, // > 60 weeks
    ];
    for (const override of cases) {
      const title = newTitle();
      await expect(createRecurringSeries({ ...crossing(title), ...override }, judoClubId)).rejects.toBeInstanceOf(
        RecurrenceError
      );
      const { count: seriesCount } = await admin
        .from("session_series")
        .select("id", { count: "exact", head: true })
        .eq("club_id", judoClubId)
        .eq("title", title);
      expect(seriesCount).toBe(0);
      const { count: sessionCount } = await admin
        .from("session")
        .select("id", { count: "exact", head: true })
        .eq("title", title);
      expect(sessionCount).toBe(0);
    }
  });

  test("(c2) a blank or over-long title is rejected before any write", async () => {
    await expect(createRecurringSeries(crossing(""), judoClubId)).rejects.toThrow();
    const long = "x".repeat(201);
    await expect(createRecurringSeries(crossing(long), judoClubId)).rejects.toThrow();
    const { count } = await admin
      .from("session_series")
      .select("id", { count: "exact", head: true })
      .eq("club_id", judoClubId)
      .eq("title", long);
    expect(count).toBe(0);
  });

  test("(d) a roster import failure leaves no sessions and no series row", async () => {
    // The brief's shared-email trigger is impossible here (person has a unique
    // (club_id, lower(email)) index, so an email can't be shared by two people
    // in a club). An email too large for the unique btree index on lower(email) makes the
    // person insert fail inside resolvePeopleForRows, after the series and
    // sessions already exist.
    const title = newTitle();
    const junk = Array.from(crypto.getRandomValues(new Uint8Array(12000)), (b) => String.fromCharCode(35 + (b % 90))).join("");
    const good = row();
    const bad = row({ email: `${junk}@example.test` });
    personEmails.push(good.email, bad.email);
    // Supabase errors are plain objects, not Error instances
    await expect(createRecurringSeries({ ...crossing(title), rows: [good, bad] }, judoClubId)).rejects.toMatchObject({
      code: "54000",
    });

    const { count: sessionCount } = await admin
      .from("session")
      .select("id", { count: "exact", head: true })
      .eq("club_id", judoClubId)
      .eq("title", title);
    expect(sessionCount).toBe(0);
    const { count: seriesCount } = await admin
      .from("session_series")
      .select("id", { count: "exact", head: true })
      .eq("club_id", judoClubId)
      .eq("title", title);
    expect(seriesCount).toBe(0);
  });

  test("(e) another club does not see the series' occurrences", async () => {
    const title = newTitle();
    const result = await createRecurringSeries(crossing(title), judoClubId);

    const { data: owned } = await admin.from("session").select("club_id").in("id", result.sessionIds);
    expect(owned!.every((s) => s.club_id === judoClubId)).toBe(true);

    const other = await listRecentSessions(taekwondoClubId);
    expect(other.some((s) => s.title === title || result.sessionIds.includes(s.id))).toBe(false);
  });
});
