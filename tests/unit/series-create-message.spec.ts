import { test, expect } from "@playwright/test";
import { seriesCreateFailureMessage } from "@/lib/session-series/create";

test.describe("seriesCreateFailureMessage", () => {
  test("cleaned: says nothing was kept", () => {
    expect(seriesCreateFailureMessage(true)).toContain("nothing was kept");
  });

  test("not cleaned: warns sessions may remain and points at the delete action", () => {
    const msg = seriesCreateFailureMessage(false);
    expect(msg).toContain("some sessions may remain");
    expect(msg).toContain("Delete this and all later events");
    expect(msg).not.toContain("nothing was kept");
  });
});
