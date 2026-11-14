import { test, expect } from "@playwright/test";
import { limitUpcomingPerSeries } from "@/lib/session-series/upcoming";

const s = (id: string, seriesId: string | null) => ({ id, seriesId });

test.describe("limitUpcomingPerSeries", () => {
  const input = [
    s("a1", "A"),
    s("x1", null),
    s("a2", "A"),
    s("a3", "A"),
    s("a4", "A"),
    s("x2", null),
    s("a5", "A"),
    s("a6", "A"),
  ];

  test("keeps 3 of a 6-session series plus both non-series sessions", () => {
    const { shown, hiddenCountBySeries } = limitUpcomingPerSeries(input, 3);
    expect(shown.map((x) => x.id)).toEqual(["a1", "x1", "a2", "a3", "x2"]);
    expect(hiddenCountBySeries.get("A")).toBe(3);
    expect(hiddenCountBySeries.size).toBe(1);
  });

  test("preserves input order", () => {
    const { shown } = limitUpcomingPerSeries(input, 2);
    expect(shown.map((x) => x.id)).toEqual(["a1", "x1", "a2", "x2"]);
  });

  test("leaves a series with 2 sessions untouched", () => {
    const two = [s("b1", "B"), s("b2", "B")];
    const { shown, hiddenCountBySeries } = limitUpcomingPerSeries(two, 3);
    expect(shown).toEqual(two);
    expect(hiddenCountBySeries.size).toBe(0);
  });

  test("caps each series independently, not globally", () => {
    const two = [
      s("a1", "A"),
      s("b1", "B"),
      s("a2", "A"),
      s("b2", "B"),
      s("a3", "A"),
      s("b3", "B"),
    ];
    const { shown, hiddenCountBySeries } = limitUpcomingPerSeries(two, 2);
    expect(shown.map((x) => x.id)).toEqual(["a1", "b1", "a2", "b2"]);
    expect(hiddenCountBySeries.get("A")).toBe(1);
    expect(hiddenCountBySeries.get("B")).toBe(1);
  });

  test("perSeries 0 hides all series members but never non-series sessions", () => {
    const { shown, hiddenCountBySeries } = limitUpcomingPerSeries(input, 0);
    expect(shown.map((x) => x.id)).toEqual(["x1", "x2"]);
    expect(hiddenCountBySeries.get("A")).toBe(6);
  });
});
