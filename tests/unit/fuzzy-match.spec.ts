import { test, expect } from "@playwright/test";
import { fuzzyMatches } from "@/lib/attendance/fuzzy-match";

test.describe("fuzzyMatches", () => {
  test("matches a misspelled full name against the real name", () => {
    // Reported case: "Jiehao" typed/misremembered as "Jayhao".
    expect(fuzzyMatches("jayhao", "Jiehao")).toBe(true);
  });

  test("matches at every prefix length while the user is still typing the misspelling", () => {
    // A live-filter search re-runs on every keystroke -- the match must
    // not disappear partway through typing "jayhao" one letter at a time.
    for (const prefix of ["j", "ja", "jay", "jayh", "jayha", "jayhao"]) {
      expect(fuzzyMatches(prefix, "Jiehao")).toBe(true);
    }
  });

  test("still matches a misspelled name with a surname attached", () => {
    expect(fuzzyMatches("jayhao", "Jiehao Wang")).toBe(true);
  });

  test("an exact substring always matches regardless of length", () => {
    expect(fuzzyMatches("jiehao", "Jiehao Wang")).toBe(true);
  });

  test("does not match a completely unrelated name", () => {
    expect(fuzzyMatches("jayhao", "Priya Sharma")).toBe(false);
  });

  test("empty query matches nothing", () => {
    expect(fuzzyMatches("", "Jiehao")).toBe(false);
    expect(fuzzyMatches("   ", "Jiehao")).toBe(false);
  });
});
