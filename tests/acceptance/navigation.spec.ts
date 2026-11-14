import { test, expect, acceptanceContext, signInThroughLoginForm } from "./support/fixtures";

test("(a) signing in lands on the sessions page with its heading", async ({ signedIn: page }) => {
  const { clubSlug } = acceptanceContext();
  await expect(page).toHaveURL(new RegExp(`/club/${clubSlug}/sessions$`));
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
});

test("(b) navigating to Purchases shows a pending spinner, then the skeleton, then the page", async ({
  signedIn: page,
}) => {
  // Needs `next dev` (the config's own server): dev does not prefetch, and the
  // chunk name matched below is Turbopack-dev specific. An external server
  // (ACCEPTANCE_BASE_URL) may be a production build where neither holds.
  test.skip(!!process.env.ACCEPTANCE_BASE_URL, "needs the config's own `next dev` server");

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Phase 1: the RSC request for the purchases page is slow -> the link shows
  // its pending spinner. (In `next dev` nothing is prefetched, so this one
  // request is the whole server round trip.)
  await page.route(/\/admin\/purchases/, async (route) => {
    await delay(1500);
    await route.continue();
  });
  // Phase 2: once the RSC response arrives, the loading.tsx skeleton shows
  // until the page's own chunk loads. Playwright cannot stream a response, so
  // the skeleton is only observable by delaying that chunk separately (the
  // Turbopack dev chunk name contains `purchases_page`).
  await page.route(/purchases_page.*\.js/, async (route) => {
    await delay(2500);
    await route.continue();
  });

  const link = page.getByRole("link", { name: "Purchases" });
  await link.click();

  await expect(page.locator('[data-testid="link-pending"]')).toBeVisible();
  await expect(page.locator('[data-testid="page-skeleton"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Purchases" })).toBeVisible();
});

test("(c) a wrong password stays on /login with an error", async ({ page }) => {
  const { email } = acceptanceContext();
  await signInThroughLoginForm(page, email, "definitely-not-the-password");
  await expect(page.getByText("Invalid email or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("(d) the sessions page signed out redirects to /login", async ({ page }) => {
  const { clubSlug } = acceptanceContext();
  await page.goto(`/club/${clubSlug}/sessions`);
  await expect(page).toHaveURL(/\/login$/);
});

test("(e) the throwaway admin cannot open another club's sessions", async ({ signedIn: page }) => {
  // Observed today: requireAdmin throws UnauthorizedError for a club the
  // user does not administer, and the app redirects to /login.
  await page.goto("/club/judo/sessions");
  await expect(page).toHaveURL(/\/login$/);
  // The judo sessions page never rendered.
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toHaveCount(0);
});
