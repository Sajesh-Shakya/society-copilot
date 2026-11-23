import { test, expect } from "@playwright/test";
import { formatPounds, signupBand, owedRange, formatSessionLabel } from "@/lib/dashboard/format";
import { validateTargets } from "@/lib/dashboard/targets";

test("formatPounds", () => {
  expect(formatPounds(500)).toBe("£5.00");
  expect(formatPounds(123450)).toBe("£1,234.50");
  expect(formatPounds(0)).toBe("£0.00");
});

test("signupBand", () => {
  expect(signupBand(20, 20, 15)).toBe("green");
  expect(signupBand(19, 20, 15)).toBe("amber");
  expect(signupBand(15, 20, 15)).toBe("amber");
  expect(signupBand(14, 20, 15)).toBe("red");
  expect(signupBand(null, 20, 15)).toBe("none");
});

test("owedRange", () => {
  expect(owedRange(3, [500, 800])).toEqual({ lowPence: 1500, highPence: 2400 });
  expect(owedRange(3, [])).toBeNull();
  expect(owedRange(0, [500, 800])).toEqual({ lowPence: 0, highPence: 0 });
});

test("validateTargets rejects min above target and bad numbers", () => {
  expect(validateTargets({ signupTarget: 20, signupMin: 15 })).toEqual({ signupTarget: 20, signupMin: 15 });
  expect(validateTargets({ signupTarget: 10, signupMin: 15 })).toHaveProperty("error");
  expect(validateTargets({ signupTarget: -1, signupMin: 0 })).toHaveProperty("error");
  expect(validateTargets({ signupTarget: 1.5, signupMin: 1 })).toHaveProperty("error");
});

test("formatSessionLabel is dd/mm h:mm AM/PM in UK local time", () => {
  expect(formatSessionLabel("2026-11-10T19:00:00Z")).toBe("10/11 7:00 PM");
  // BST: 18:00Z in July is 19:00 in London
  expect(formatSessionLabel("2026-07-07T18:00:00Z")).toBe("07/07 7:00 PM");
  expect(formatSessionLabel("2026-11-10T00:05:00Z")).toBe("10/11 12:05 AM");
});
