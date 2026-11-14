import {
  test,
  expect,
  adminDb,
  acceptanceContext,
  seedPerson,
  seedSession,
  seedSeries,
  seedAttended,
} from "./support/fixtures";

// Date robustness: the weekly sessions are seeded at now + 7k days (k = 1..6),
// all in the future whatever the run date; assertions use only titles and ids,
// never calendar dates.

const WEEK = 7 * 24 * 60 * 60 * 1000;

async function seedWeeklySeries(weeks: number) {
  const seriesId = await seedSeries("Weekly Judo");
  const ids: string[] = [];
  for (let k = 1; k <= weeks; k++) {
    ids.push(
      await seedSession({ title: `Weekly Judo wk${k}`, startsAt: new Date(Date.now() + k * WEEK), seriesId })
    );
  }
  const person = await seedPerson({ fullName: "Pat Attender", email: "pat.attender@example.test" });
  await seedAttended(ids[4], person); // week 5
  return { seriesId, ids };
}

async function remainingIds(seriesId: string): Promise<string[]> {
  const { data, error } = await adminDb.from("session").select("id").eq("series_id", seriesId);
  if (error) throw error;
  return (data ?? []).map((r) => r.id);
}

test("deleting from week 3 removes 3, 4 and 6 and keeps week 5 (has attendance)", async ({ signedIn: page }) => {
  const { clubSlug } = acceptanceContext();
  const { seriesId, ids } = await seedWeeklySeries(6);

  await page.goto(`/club/${clubSlug}/sessions/${ids[2]}`);
  await expect(page.getByRole("heading", { name: "Weekly Judo wk3" })).toBeVisible();
  await page.getByRole("button", { name: "Delete this and all later events" }).click();

  const panel = page.getByTestId("series-delete-panel");
  await expect(panel.getByText("3 events will be deleted, 1 kept because it has attendance")).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("listitem")).toContainText("Weekly Judo wk5");
  await expect(panel.getByRole("listitem")).toContainText("(1 attendee)");

  await panel.getByRole("button", { name: "Confirm delete" }).click();

  await expect(page).toHaveURL(new RegExp(`/club/${clubSlug}/sessions$`));
  await expect(page.getByText("Deleted 3 events. Kept 1 with recorded attendance.")).toBeVisible();

  const left = (await remainingIds(seriesId)).sort();
  expect(left).toEqual([ids[0], ids[1], ids[4]].sort());
  const { data: series, error } = await adminDb.from("session_series").select("id").eq("id", seriesId);
  if (error) throw error;
  expect(series).toHaveLength(1);
});

test("deleting from week 5 (attended, nothing later) deletes nothing and cannot be confirmed", async ({
  signedIn: page,
}) => {
  const { clubSlug } = acceptanceContext();
  const { seriesId, ids } = await seedWeeklySeries(5);

  await page.goto(`/club/${clubSlug}/sessions/${ids[4]}`);
  await expect(page.getByRole("heading", { name: "Weekly Judo wk5" })).toBeVisible();
  await page.getByRole("button", { name: "Delete this and all later events" }).click();

  const panel = page.getByTestId("series-delete-panel");
  await expect(panel.getByText("0 events will be deleted, 1 kept because it has attendance")).toBeVisible();
  await expect(panel.getByRole("listitem")).toContainText("Weekly Judo wk5");
  await expect(panel.getByRole("button", { name: "Confirm delete" })).toBeDisabled();

  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toHaveCount(0);
  expect((await remainingIds(seriesId)).sort()).toEqual([...ids].sort());
});
