import { test, expect } from "@playwright/test";
import { normalizeCid } from "@/lib/utils";

test.describe("normalizeCid", () => {
  test("pads a purely-numeric CID under 8 digits with leading zeros", () => {
    expect(normalizeCid("2665790")).toBe("02665790");
    expect(normalizeCid("123")).toBe("00000123");
  });

  test("leaves an already-8-digit CID unchanged", () => {
    expect(normalizeCid("02665790")).toBe("02665790");
  });

  test("leaves a longer numeric value unchanged (not a CID this scheme expects)", () => {
    expect(normalizeCid("123456789")).toBe("123456789");
  });

  test("leaves a non-numeric value unchanged (e.g. a real card number with letters)", () => {
    expect(normalizeCid("AB1234")).toBe("AB1234");
  });

  test("trims whitespace before checking/padding", () => {
    expect(normalizeCid("  2665790  ")).toBe("02665790");
  });
});
