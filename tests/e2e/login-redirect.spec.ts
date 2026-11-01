import { test, expect } from "@playwright/test";

// These assert on the redirect target reachable from the login form's
// client-visible behavior, mirroring the existing admin-auth-gate.spec.ts
// pattern of checking URLs rather than seeding real Supabase Auth users
// (which these three cases would otherwise require).
test("the login page still renders the email/password form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("/select-club redirects an unauthenticated visitor to /login", async ({ page }) => {
  await page.goto("/select-club");
  await expect(page).toHaveURL(/\/login$/);
});

test("/club/judo redirects an unauthenticated visitor to /login", async ({ page }) => {
  await page.goto("/club/judo");
  await expect(page).toHaveURL(/\/login$/);
});
