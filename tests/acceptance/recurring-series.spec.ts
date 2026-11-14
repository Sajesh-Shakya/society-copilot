import type { Page } from "@playwright/test";
import { test, expect, adminDb, acceptanceContext } from "./support/fixtures";
import { randomHex } from "./support/db";

// Date robustness: this spec uses FIXED dates (2026-10-19 .. 2026-11-02) on
// purpose: it asserts the Europe/London -> UTC conversion across the 25 Oct
// 2026 clock change (BST -> GMT), from the stored instants in the DB. It never
// depends on where the sessions sit relative to "now" (they are past today).

const CSV_HEADER = "Date,CID/Card Number,Login,First Name,Surname,Email,Event Title,Signup Title,Attended";
const row = (first: string, last: string, email: string) =>
  `19/10/2026,,login,${first},${last},${email},Series,Series,`;

function csvFile(lines: string[]) {
  return { name: "signups.csv", mimeType: "text/csv", buffer: Buffer.from([CSV_HEADER, ...lines].join("\n"), "utf-8") };
}

async function openForm(page: Page) {
  const { clubSlug } = acceptanceContext();
  await page.goto(`/club/${clubSlug}/sessions/recurring`);
  await expect(page.getByLabel("Session title")).toBeVisible();
}

async function fillForm(page: Page, v: { title: string; start: string; end: string }) {
  await page.getByLabel("Session title").fill(v.title);
  await page.getByLabel("First session date").fill("2026-10-19");
  await page.getByLabel("Start time").fill(v.start);
  await page.getByLabel("End time").fill(v.end);
  await page.getByLabel("Repeat weekly until").fill("2026-11-02");
}

async function sessionsTitled(title: string) {
  const { clubId } = acceptanceContext();
  const { data, error } = await adminDb
    .from("session")
    .select("id, starts_at, ends_at")
    .eq("club_id", clubId)
    .eq("title", title)
    .order("starts_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

test("(a) a weekly 19:00-20:30 series with a signup CSV is stored correctly across the clock change", async ({
  signedIn: page,
}) => {
  const { clubSlug } = acceptanceContext();
  const title = `Judo Series ${randomHex(3)}`;
  await openForm(page);
  await fillForm(page, { title, start: "19:00", end: "20:30" });
  await page.locator("#file").setInputFiles(
    csvFile([
      row("Alice", "Anderson", "alice.anderson@example.test"),
      row("Bruno", "Baptiste", "bruno.baptiste@example.test"),
      row("Chloe", "Campbell", "chloe.campbell@example.test"),
    ])
  );
  await page.getByRole("button", { name: "Create series" }).click();

  await expect(page).toHaveURL(new RegExp(`/club/${clubSlug}/sessions/[0-9a-f-]{36}$`));
  await expect(page.getByText("Created 3 weekly sessions. Imported 3 attendee(s) into the first one.")).toBeVisible();

  // Stored UTC instants: BST (UTC+1) on 19 Oct, GMT from 25 Oct.
  const sessions = await sessionsTitled(title);
  expect(sessions.map((s) => new Date(s.starts_at).toISOString())).toEqual([
    "2026-10-19T18:00:00.000Z",
    "2026-10-26T19:00:00.000Z",
    "2026-11-02T19:00:00.000Z",
  ]);
  expect(sessions.map((s) => new Date(s.ends_at!).getTime() - new Date(s.starts_at).getTime())).toEqual([
    90 * 60_000,
    90 * 60_000,
    90 * 60_000,
  ]);

  // The redirect landed on the first session, which lists the 3 attendees.
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessions[0].id}$`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  for (const name of ["Alice Anderson", "Bruno Baptiste", "Chloe Campbell"]) {
    await expect(page.getByText(name)).toBeVisible();
  }

  // The second session has none.
  await page.goto(`/club/${clubSlug}/sessions/${sessions[1].id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("No one on the roster yet")).toBeVisible();
  await expect(page.getByText("Alice Anderson")).toHaveCount(0);
});

test("(b) an end time before the start time shows the validation message and creates nothing", async ({
  signedIn: page,
}) => {
  const { clubSlug } = acceptanceContext();
  const title = `Bad Times ${randomHex(3)}`;
  await openForm(page);
  await fillForm(page, { title, start: "20:30", end: "19:00" });
  await page.getByRole("button", { name: "Create series" }).click();

  await expect(page.getByText("End time must be after the start time.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/club/${clubSlug}/sessions/recurring$`));
  expect(await sessionsTitled(title)).toHaveLength(0);
});

test("(c) a CSV with a bad row creates nothing", async ({ signedIn: page }) => {
  const { clubSlug, clubId } = acceptanceContext();
  const title = `Bad Csv ${randomHex(3)}`;
  await openForm(page);
  await fillForm(page, { title, start: "19:00", end: "20:30" });
  await page.locator("#file").setInputFiles(
    csvFile([row("Alice", "Anderson", "alice.anderson@example.test"), row("Dana", "", "dana@example.test")])
  );
  await page.getByRole("button", { name: "Create series" }).click();

  await expect(page.getByText(/1 row\(s\) failed/)).toBeVisible();
  await expect(page.getByText(/row 2: missing Surname/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/club/${clubSlug}/sessions/recurring$`));
  expect(await sessionsTitled(title)).toHaveLength(0);
  const { data, error } = await adminDb.from("session_series").select("id").eq("club_id", clubId).eq("title", title);
  if (error) throw error;
  expect(data).toHaveLength(0);
});
