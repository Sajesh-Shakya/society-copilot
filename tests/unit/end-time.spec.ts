import { test, expect } from "@playwright/test";
import { normalizeEventEnd, formatSessionTimes } from "@/lib/attendance/end-time";

const START = "2026-11-13T18:00:00.000Z";

test.describe("normalizeEventEnd", () => {
  test("returns a valid later end as an ISO instant", () => {
    expect(normalizeEventEnd(START, "2026-11-13T20:00:00Z")).toBe("2026-11-13T20:00:00.000Z");
  });
  test("returns null for unparseable input", () => {
    expect(normalizeEventEnd(START, "not a date")).toBeNull();
  });
  test("returns null when equal to start", () => {
    expect(normalizeEventEnd(START, START)).toBeNull();
  });
  test("returns null when before start", () => {
    expect(normalizeEventEnd(START, "2026-11-13T17:00:00Z")).toBeNull();
  });
  test("returns null when undefined, null or empty", () => {
    expect(normalizeEventEnd(START, undefined)).toBeNull();
    expect(normalizeEventEnd(START, null)).toBeNull();
    expect(normalizeEventEnd(START, "")).toBeNull();
  });
});

// Built from local-time components and compared against the same locale
// formatters, so the assertions hold in any process timezone.
test.describe("formatSessionTimes", () => {
  const start = new Date(2026, 10, 13, 18, 0);
  const sameDayEnd = new Date(2026, 10, 13, 20, 30);
  const nextDayEnd = new Date(2026, 10, 14, 1, 0);

  test("start only when there is no end", () => {
    expect(formatSessionTimes(start.toISOString(), null)).toBe(start.toLocaleString());
  });
  test("same-day end shows the end as time only", () => {
    expect(formatSessionTimes(start.toISOString(), sameDayEnd.toISOString())).toBe(
      `${start.toLocaleString()} – ${sameDayEnd.toLocaleTimeString()}`
    );
  });
  test("next-day end shows the full end date-time", () => {
    expect(formatSessionTimes(start.toISOString(), nextDayEnd.toISOString())).toBe(
      `${start.toLocaleString()} – ${nextDayEnd.toLocaleString()}`
    );
  });
});
