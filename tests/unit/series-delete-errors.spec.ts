import { test, expect } from "@playwright/test";
import { describeDeleteFailure } from "@/lib/session-series/delete";

test.describe("describeDeleteFailure", () => {
  test("23503 explains the new attendance and includes the deleted count", () => {
    const msg = describeDeleteFailure({ code: "23503" }, 7);
    expect(msg).toContain("now has recorded attendance");
    expect(msg).toContain("7 event(s) were deleted");
    expect(msg).toContain("unattended roster rows of the failing batch were already removed");
  });

  test("other errors give generic text with the count and no database text", () => {
    const msg = describeDeleteFailure({ code: "57014" }, 3);
    expect(msg).toContain("failed after 3 event(s)");
    expect(msg).toContain("Reload to see what is left");
    expect(msg).not.toContain("attendance, so it was not deleted");
  });

  test("an error without a code is generic", () => {
    expect(describeDeleteFailure({}, 0)).toContain("failed after 0 event(s)");
  });
});
