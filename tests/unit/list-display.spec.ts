import { test, expect } from "@playwright/test";
import { splitSessionsForDisplay } from "@/lib/attendance/list-display";

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

test.describe("splitSessionsForDisplay", () => {
  test("shows the first 3 of 7 and folds the rest in order", () => {
    const { shown, folded } = splitSessionsForDisplay(items(7), 3);
    expect(shown.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(folded.map((x) => x.id)).toEqual(["4", "5", "6", "7"]);
  });

  test("folds nothing when the list is at the visible count", () => {
    const { shown, folded } = splitSessionsForDisplay(items(3), 3);
    expect(shown).toHaveLength(3);
    expect(folded).toEqual([]);
  });

  test("handles an empty list", () => {
    expect(splitSessionsForDisplay([], 3)).toEqual({ shown: [], folded: [] });
  });

  test("a visibleCount of 0 folds everything", () => {
    const { shown, folded } = splitSessionsForDisplay(items(4), 0);
    expect(shown).toEqual([]);
    expect(folded.map((x) => x.id)).toEqual(["1", "2", "3", "4"]);
  });

  test("a negative visibleCount shows none", () => {
    const { shown, folded } = splitSessionsForDisplay(items(2), -1);
    expect(shown).toEqual([]);
    expect(folded).toHaveLength(2);
  });

  test("does not mutate the input array", () => {
    const input = items(5);
    const copy = [...input];
    splitSessionsForDisplay(input, 3);
    expect(input).toEqual(copy);
  });
});
