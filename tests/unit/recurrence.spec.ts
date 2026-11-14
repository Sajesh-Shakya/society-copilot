import { test, expect } from "@playwright/test";
import {
  MAX_OCCURRENCES,
  RecurrenceError,
  SERIES_TIME_ZONE,
  londonWallTimeToUtc,
  weeklyOccurrences,
} from "@/lib/session-series/recurrence";

const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

test.describe("constants", () => {
  test("values", () => {
    expect(SERIES_TIME_ZONE).toBe("Europe/London");
    expect(MAX_OCCURRENCES).toBe(60);
  });
});

test.describe("weeklyOccurrences", () => {
  test("autumn crossing keeps London wall time", () => {
    const occ = weeklyOccurrences({
      firstDate: "2026-10-19",
      startTime: "19:00",
      endTime: "20:30",
      untilDate: "2026-11-02",
    });
    expect(occ.map((o) => iso(o.startsAt))).toEqual([
      "2026-10-19T18:00:00Z",
      "2026-10-26T19:00:00Z",
      "2026-11-02T19:00:00Z",
    ]);
    for (const o of occ) {
      expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe(90 * 60_000);
    }
  });

  test("spring crossing", () => {
    const occ = weeklyOccurrences({
      firstDate: "2027-03-22",
      startTime: "19:00",
      endTime: "20:00",
      untilDate: "2027-03-29",
    });
    expect(occ.map((o) => iso(o.startsAt))).toEqual([
      "2027-03-22T19:00:00Z",
      "2027-03-29T18:00:00Z",
    ]);
  });

  test("untilDate is inclusive; day before excludes", () => {
    const base = { firstDate: "2026-11-02", startTime: "10:00", endTime: "11:00" };
    expect(weeklyOccurrences({ ...base, untilDate: "2026-11-09" })).toHaveLength(2);
    expect(weeklyOccurrences({ ...base, untilDate: "2026-11-08" })).toHaveLength(1);
  });

  test("exactly 60 allowed, 61 rejected", () => {
    const base = { firstDate: "2026-01-05", startTime: "10:00", endTime: "11:00" };
    // 59 weeks after 2026-01-05 is 2027-02-22
    expect(weeklyOccurrences({ ...base, untilDate: "2027-02-22" })).toHaveLength(60);
    expect(() => weeklyOccurrences({ ...base, untilDate: "2027-03-01" })).toThrow(RecurrenceError);
  });

  test("huge range fails fast", () => {
    const start = Date.now();
    expect(() =>
      weeklyOccurrences({
        firstDate: "2026-01-05",
        startTime: "10:00",
        endTime: "11:00",
        untilDate: "2207-01-05",
      }),
    ).toThrow(RecurrenceError);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("rejections", () => {
    const ok = { firstDate: "2026-11-02", startTime: "10:00", endTime: "11:00", untilDate: "2026-11-09" };
    expect(() => weeklyOccurrences({ ...ok, endTime: "10:00" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, endTime: "09:00" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, untilDate: "2026-11-01" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, firstDate: "2026-13-01" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, firstDate: "2026-02-30" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, untilDate: "2026-13-01" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, startTime: "7pm" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, endTime: "24:00" })).toThrow(RecurrenceError);
    expect(() => weeklyOccurrences({ ...ok, endTime: "19:60" })).toThrow(RecurrenceError);
  });

  test("RecurrenceError is an Error with a message", () => {
    try {
      weeklyOccurrences({ firstDate: "x", startTime: "10:00", endTime: "11:00", untilDate: "2026-11-09" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RecurrenceError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message.length).toBeGreaterThan(0);
    }
  });
});

test.describe("londonWallTimeToUtc", () => {
  test("GMT and BST basics", () => {
    expect(iso(londonWallTimeToUtc("2026-01-15", "09:30"))).toBe("2026-01-15T09:30:00Z");
    expect(iso(londonWallTimeToUtc("2026-07-15", "09:30"))).toBe("2026-07-15T08:30:00Z");
  });

  test("spring gap resolves to just after the gap", () => {
    expect(iso(londonWallTimeToUtc("2027-03-28", "01:30"))).toBe("2027-03-28T01:30:00Z");
    expect(iso(londonWallTimeToUtc("2027-03-28", "01:00"))).toBe("2027-03-28T01:00:00Z");
    expect(iso(londonWallTimeToUtc("2027-03-28", "02:00"))).toBe("2027-03-28T01:00:00Z");
    expect(iso(londonWallTimeToUtc("2027-03-28", "00:59"))).toBe("2027-03-28T00:59:00Z");
  });

  test("autumn overlap resolves to first (BST) occurrence", () => {
    expect(iso(londonWallTimeToUtc("2026-10-25", "01:30"))).toBe("2026-10-25T00:30:00Z");
    expect(iso(londonWallTimeToUtc("2026-10-25", "02:00"))).toBe("2026-10-25T02:00:00Z");
  });

  test("round trip across a year", () => {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const base = Date.UTC(2026, 0, 1, 0, 7);
    for (let i = 0; i < 100; i++) {
      const inst = new Date(base + i * 87 * 3_600_000 + 13 * 60_000);
      const p = Object.fromEntries(fmt.formatToParts(inst).map((x) => [x.type, x.value]));
      const hour = p.hour === "24" ? "00" : p.hour;
      const date = `${p.year}-${p.month}-${p.day}`;
      const time = `${hour}:${p.minute}`;
      const back = londonWallTimeToUtc(date, time);
      const q = Object.fromEntries(fmt.formatToParts(back).map((x) => [x.type, x.value]));
      const h2 = q.hour === "24" ? "00" : q.hour;
      expect(`${q.year}-${q.month}-${q.day}`).toBe(date);
      expect(`${h2}:${q.minute}`).toBe(time);
    }
  });

  test("malformed input throws", () => {
    for (const [d, t] of [
      ["2026-13-01", "10:00"],
      ["2026-02-30", "10:00"],
      ["2026-1-01", "10:00"],
      ["2026-11-02", "7pm"],
      ["2026-11-02", "24:00"],
      ["2026-11-02", "19:60"],
      ["2026-11-02", "9:00"],
    ]) {
      expect(() => londonWallTimeToUtc(d, t)).toThrow(RecurrenceError);
    }
  });
});

test.describe("clock-change days", () => {
  test("end before start across the spring gap is rejected, naming the date", () => {
    for (const [startTime, endTime] of [
      ["01:30", "02:15"],
      ["01:59", "02:00"],
    ]) {
      let err: unknown;
      try {
        weeklyOccurrences({ firstDate: "2027-03-21", startTime, endTime, untilDate: "2027-03-28" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RecurrenceError);
      expect((err as Error).message).toContain("2027-03-28");
    }
  });

  test("valid cases on the change day still succeed", () => {
    const [a] = weeklyOccurrences({
      firstDate: "2027-03-28",
      startTime: "00:30",
      endTime: "01:30",
      untilDate: "2027-03-28",
    });
    expect(a.endsAt.getTime()).toBeGreaterThan(a.startsAt.getTime());
    const occ = weeklyOccurrences({
      firstDate: "2027-03-22",
      startTime: "19:00",
      endTime: "20:30",
      untilDate: "2027-03-29",
    });
    expect(occ.map((o) => iso(o.startsAt))).toEqual(["2027-03-22T19:00:00Z", "2027-03-29T18:00:00Z"]);
    for (const o of occ) expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe(90 * 60_000);
  });

  test("00:00 and 23:59 boundaries", () => {
    expect(iso(londonWallTimeToUtc("2026-01-15", "00:00"))).toBe("2026-01-15T00:00:00Z");
    expect(iso(londonWallTimeToUtc("2026-07-15", "00:00"))).toBe("2026-07-14T23:00:00Z");
    expect(iso(londonWallTimeToUtc("2026-07-15", "23:59"))).toBe("2026-07-15T22:59:00Z");
    const [o] = weeklyOccurrences({
      firstDate: "2026-07-15",
      startTime: "00:00",
      endTime: "23:59",
      untilDate: "2026-07-15",
    });
    expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe((24 * 60 - 1) * 60_000);
  });
});
