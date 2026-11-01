import { test, expect } from "@playwright/test";

// The main happy path for admin-gated pages, without needing a real signed-in
// session: an unauthenticated visitor is bounced to /login rather than
// seeing the page or a raw error. This exercises requireAdmin()'s redirect
// behavior against a real running server for every route that's supposed to
// be admin-only.
test.describe("admin route gating", () => {
  for (const path of [
    "/",
    "/club/judo",
    "/club/judo/sessions",
    "/club/judo/sessions/new",
    "/club/judo/sessions/import",
    "/club/judo/admin/purchases",
    "/club/judo/admin/chase-inbox",
    "/club/judo/admin/unpaid",
    "/select-club",
  ]) {
    test(`${path} redirects an unauthenticated visitor to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    });
  }

  test("an unknown club slug redirects an unauthenticated visitor to /login, same as a known one", async ({ page }) => {
    await page.goto("/club/not-a-real-club/sessions");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the old /sessions path no longer exists", async ({ page }) => {
    const response = await page.goto("/sessions");
    expect(response?.status()).toBe(404);
  });
});
