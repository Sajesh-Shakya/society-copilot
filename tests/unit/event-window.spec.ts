import { test, expect } from "@playwright/test";
import { isInPrefetchWindow } from "@/lib/attendance/event-window";

const startsAt = new Date("2026-11-13T18:00:00Z");
const endsAt = new Date("2026-11-13T20:00:00Z");
const at = (hhmm: string) => new Date(`2026-11-13T${hhmm}:00Z`);

test.describe("isInPrefetchWindow", () => {
  test("opens exactly 60 minutes before start (inclusive)", () => {
    expect(isInPrefetchWindow({ startsAt, endsAt, cancelledAt: null, now: at("17:00") })).toBe(true);
    expect(isInPrefetchWindow({ startsAt, endsAt, cancelledAt: null, now: at("16:59") })).toBe(false);
  });

  test("closes exactly 60 minutes after end (inclusive)", () => {
    expect(isInPrefetchWindow({ startsAt, endsAt, cancelledAt: null, now: at("21:00") })).toBe(true);
    expect(isInPrefetchWindow({ startsAt, endsAt, cancelledAt: null, now: at("21:01") })).toBe(false);
  });

  test("null endsAt defaults to start + 2h", () => {
    expect(isInPrefetchWindow({ startsAt, endsAt: null, cancelledAt: null, now: at("21:00") })).toBe(true);
    expect(isInPrefetchWindow({ startsAt, endsAt: null, cancelledAt: null, now: at("21:01") })).toBe(false);
  });

  test("cancelled sessions are never in the window", () => {
    expect(
      isInPrefetchWindow({ startsAt, endsAt, cancelledAt: at("12:00"), now: at("18:30") }),
    ).toBe(false);
  });
});
