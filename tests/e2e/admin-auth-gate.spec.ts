import { test, expect } from "@playwright/test";

// The main happy path for admin-gated pages, without needing a real signed-in
// session: an unauthenticated visitor is bounced to /login rather than
// seeing the page or a raw error. This exercises requireAdmin()'s redirect
// behavior against a real running server for every route that's supposed to
// be admin-only.
test.describe("admin route gating", () => {
  for (const path of ["/", "/sessions", "/sessions/new", "/admin/purchases", "/admin/chase-inbox", "/admin/unpaid"]) {
    test(`${path} redirects an unauthenticated visitor to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    });
  }
});
