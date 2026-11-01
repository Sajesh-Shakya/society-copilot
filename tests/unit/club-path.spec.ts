import { test, expect } from "@playwright/test";
import { clubPath } from "@/lib/club-path";

test("clubPath joins a club slug and a path, normalizing a missing leading slash", () => {
  expect(clubPath("judo", "/sessions")).toBe("/club/judo/sessions");
  expect(clubPath("judo", "sessions")).toBe("/club/judo/sessions");
  expect(clubPath("judo", "/sessions/new")).toBe("/club/judo/sessions/new");
});
