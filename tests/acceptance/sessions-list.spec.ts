import { test, expect, acceptanceContext, seedSession, seedSeries } from "./support/fixtures";
import type { Page } from "@playwright/test";

// Date robustness: every session is seeded relative to the instant the test
// runs (+k days / -k days, k = 1..7), so the assertions hold on any run date.
// Whole-day offsets never share a UTC calendar date with "now", so none is
// grouped under "Today"; all lie inside the page's 30-day past window.

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

async function openList(page: Page) {
  const { clubSlug } = acceptanceContext();
  await page.goto(`/club/${clubSlug}/sessions`);
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
}

/** A session row link that is NOT inside any <details>. */
const outside = (page: Page, title: string) =>
  page.locator("xpath=//a[not(ancestor::details)]").filter({ hasText: title });
const insideAnyDetails = (page: Page, title: string) =>
  page.locator("details a").filter({ hasText: title });

test("(a) 7 upcoming sessions: 3 shown, 4 folded in 'Show 4 more upcoming'", async ({ signedIn: page }) => {
  for (let i = 1; i <= 7; i++) await seedSession({ title: `Up ${i}`, startsAt: daysFromNow(i) });
  await openList(page);

  for (const i of [1, 2, 3]) {
    await expect(outside(page, `Up ${i}`)).toHaveCount(1);
    await expect(outside(page, `Up ${i}`)).toBeVisible();
    await expect(insideAnyDetails(page, `Up ${i}`)).toHaveCount(0);
  }
  for (const i of [4, 5, 6, 7]) await expect(outside(page, `Up ${i}`)).toHaveCount(0);

  const more = page.locator('details[data-testid="upcoming-more"]');
  await expect(page.locator("details")).toHaveCount(1);
  await expect(more.locator("summary")).toHaveText("Show 4 more upcoming");
  // getByRole skips content of a closed <details> (inaccessible), so use "a" here.
  for (const i of [4, 5, 6, 7]) await expect(more.locator("a").filter({ hasText: `Up ${i}` })).toHaveCount(1);
  // Closed: the folded rows are not visible.
  await expect(more.locator("a").filter({ hasText: "Up 4" })).toBeHidden();

  await more.locator("summary").click();
  for (const i of [4, 5, 6, 7]) await expect(more.getByRole("link").filter({ hasText: `Up ${i}` })).toBeVisible();
});

test("(b) 6 past sessions: 3 newest shown, 3 folded in 'Show 3 earlier'", async ({ signedIn: page }) => {
  for (let i = 1; i <= 6; i++) await seedSession({ title: `Past ${i}`, startsAt: daysFromNow(-i) });
  await openList(page);

  // Past 1 is the newest.
  for (const i of [1, 2, 3]) {
    await expect(outside(page, `Past ${i}`)).toBeVisible();
    await expect(insideAnyDetails(page, `Past ${i}`)).toHaveCount(0);
  }
  const more = page.locator('details[data-testid="past-more"]');
  await expect(page.locator("details")).toHaveCount(1);
  await expect(more.locator("summary")).toHaveText("Show 3 earlier");
  for (const i of [4, 5, 6]) {
    await expect(outside(page, `Past ${i}`)).toHaveCount(0);
    await expect(more.locator("a").filter({ hasText: `Past ${i}` })).toHaveCount(1);
  }
  await expect(more.locator("a").filter({ hasText: "Past 4" })).toBeHidden();
  await more.locator("summary").click();
  for (const i of [4, 5, 6]) await expect(more.getByRole("link").filter({ hasText: `Past ${i}` })).toBeVisible();
});

test("(c) with only 2 upcoming sessions there is no upcoming drop-down", async ({ signedIn: page }) => {
  await seedSession({ title: "Up 1", startsAt: daysFromNow(1) });
  await seedSession({ title: "Up 2", startsAt: daysFromNow(2) });
  await openList(page);

  await expect(outside(page, "Up 1")).toBeVisible();
  await expect(outside(page, "Up 2")).toBeVisible();
  await expect(page.locator('[data-testid="upcoming-more"]')).toHaveCount(0);
  await expect(page.locator("details")).toHaveCount(0);
});

test("(d) a session starting today stays outside any drop-down among many others", async ({ signedIn: page }) => {
  for (let i = 1; i <= 6; i++) await seedSession({ title: `Up ${i}`, startsAt: daysFromNow(i) });
  for (let i = 1; i <= 5; i++) await seedSession({ title: `Past ${i}`, startsAt: daysFromNow(-i) });
  // Starts "now" (the instant of seeding). The page groups by UTC date, so the
  // only flake risk is the test straddling 00:00 UTC between seeding and load.
  await seedSession({ title: "Starts today", startsAt: new Date() });
  await openList(page);

  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(outside(page, "Starts today")).toBeVisible();
  await expect(insideAnyDetails(page, "Starts today")).toHaveCount(0);
  // The drop-downs still exist for the others, so the check above is meaningful.
  await expect(page.locator('[data-testid="upcoming-more"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="past-more"]')).toHaveCount(1);
});

test("(e) the text 'more in this series' appears nowhere", async ({ signedIn: page }) => {
  const seriesId = await seedSeries("Weekly");
  for (let i = 1; i <= 5; i++) await seedSession({ title: `Weekly ${i}`, startsAt: daysFromNow(i * 7), seriesId });
  await openList(page);

  await expect(outside(page, "Weekly 1")).toBeVisible();
  await expect(page.getByText(/more in this series/i)).toHaveCount(0);
  await page.locator('[data-testid="upcoming-more"] summary').click();
  await expect(page.getByText(/more in this series/i)).toHaveCount(0);
});
