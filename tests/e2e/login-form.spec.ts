import { test, expect } from "@playwright/test";

// Exercises the password sign-in form against the real, running Supabase
// project (same live-server pattern as admin-auth-gate.spec.ts). A full
// successful-login happy path would require provisioning a real test admin
// account via scripts/create-admin.ts first — out of scope for an automated
// run that shouldn't be creating live auth users on every CI pass. This
// covers what's cheap and deterministic: the invalid-credentials path, which
// exercises the full signIn() Server Action round-trip against Supabase Auth
// without needing a pre-existing account.
test("rejects invalid credentials and stays on /login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("not-a-real-admin@example.com");
  await page.getByLabel("Password").fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Invalid email or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("requires both fields before the submit button is enabled", async ({ page }) => {
  await page.goto("/login");
  const submit = page.getByRole("button", { name: "Sign in" });
  await expect(submit).toBeDisabled();

  await page.getByLabel("Email").fill("someone@ic.ac.uk");
  await expect(submit).toBeDisabled();

  await page.getByLabel("Password").fill("something");
  await expect(submit).toBeEnabled();
});
