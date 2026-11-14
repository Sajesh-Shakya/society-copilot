import { test, expect } from "@playwright/test";
import { chunk } from "@/lib/session-series/delete";

test.describe("chunk", () => {
  test("empty input gives no chunks", () => {
    expect(chunk([], 100)).toEqual([]);
  });

  test("exact multiple", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  test("remainder goes in a final short chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("250 items at size 100 is 3 chunks", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const out = chunk(items, 100);
    expect(out.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(out.flat()).toEqual(items);
  });

  test("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});
