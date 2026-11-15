import { randomInt } from "crypto";
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  adminDb,
  acceptanceContext,
  seedPerson,
  seedProduct,
  seedPurchase,
  seedSession,
} from "./support/fixtures";
import { randomHex } from "./support/db";

// Identity trust and duplicates (docs/superpowers/specs/2026-11-14-identity-trust-and-duplicates-design.md).
// Every person, CID and email here is invented per run inside the throwaway
// e2e- club; CIDs are random, so they can only collide within that club.

/** A random 8-digit test CID with a leading 0 (Imperial-style). */
const randomCid = () => `0${randomInt(1_000_000, 10_000_000)}`;
/** A unique, letters-only surname (a name word must contain a letter). */
const surname = () => `Tester${randomHex(3).replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;

async function person(id: string) {
  const { data, error } = await adminDb.from("person").select("cid, cid_source").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function purchase(id: string) {
  const { data, error } = await adminDb
    .from("purchase")
    .select("person_id, match_status, manual_matched_by, manual_matched_at")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function openReview(page: Page) {
  const { clubSlug } = acceptanceContext();
  await page.goto(`/club/${clubSlug}/admin/people-review`);
  await expect(page.getByRole("heading", { name: "People review" })).toBeVisible();
}

const CSV_HEADER = "Date,CID/Card Number,Login,First Name,Surname,Email,Event Title,Signup Title,Attended";

test("(a) Ayaan end to end: an SSO CSV row replaces a walk-in CID, shows in Recent changes, and Re-check matches the purchase", async ({
  signedIn: page,
}) => {
  const { clubSlug } = acceptanceContext();
  const last = surname();
  const fullName = `Ayaan ${last}`;
  const email = `ayaan.${last.toLowerCase()}@example.test`;
  const wrongCid = randomCid();
  let rightCid = randomCid();
  while (rightCid === wrongCid) rightCid = randomCid();

  const personId = await seedPerson({ fullName, email, cid: wrongCid, cidSource: "walk_in" });
  const productId = await seedProduct();
  const purchaseId = await seedPurchase({
    productId,
    matchStatus: "unmatched",
    rawPersonName: fullName,
    rawCid: rightCid,
    rawMemberType: "Student",
  });

  // Import a signup CSV through the UI with the same email and the right CID.
  await page.goto(`/club/${clubSlug}/sessions/import`);
  await page.getByLabel("Session title").fill(`Identity import ${randomHex(3)}`);
  await page.getByLabel("Starts at").fill("2026-11-20T19:00");
  await page.locator("#file").setInputFiles({
    name: "signups.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [CSV_HEADER, `15/11/2026,${rightCid},login,Ayaan,${last},${email},Session,Session,`].join("\n"),
      "utf-8"
    ),
  });
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page).toHaveURL(new RegExp(`/club/${clubSlug}/sessions/[0-9a-f-]{36}$`));
  await expect(page.getByText("Imported 1 attendee(s).")).toBeVisible();

  // The CID was replaced (sso outranks walk_in).
  expect(await person(personId)).toEqual({ cid: rightCid, cid_source: "sso" });

  // "Recent changes" lists the overwrite.
  await openReview(page);
  const recent = page.locator("details").filter({ has: page.locator("summary", { hasText: "Recent changes" }) });
  await expect(recent.locator("summary")).toHaveText("Recent changes (1)");
  await recent.locator("summary").click();
  const change = recent.getByTestId("recent-change");
  await expect(change).toHaveCount(1);
  await expect(change).toContainText(`${fullName}: CID ${wrongCid} (walk_in) → ${rightCid} (sso)`);

  // "Re-check unmatched" now matches the student purchase by CID.
  await page.goto(`/club/${clubSlug}/admin/purchases`);
  const row = page.getByRole("row").filter({ hasText: fullName });
  await expect(row.getByText("unmatched", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Re-check 1 unmatched" }).click();
  await expect(page.getByText("Matched 1 purchase(s).")).toBeVisible();
  await expect(row.getByText("cid_matched", { exact: true })).toBeVisible();

  const after = await purchase(purchaseId);
  expect(after.person_id).toBe(personId);
  expect(after.match_status).toBe("cid_matched");
});

test("(b) manual match from a suggestion with 'Use this purchase's CID' sets the person's CID", async ({
  signedIn: page,
}) => {
  const { clubSlug } = acceptanceContext();
  const last = surname();
  const fullName = `Priya ${last}`;
  const email = `priya.${last.toLowerCase()}@example.test`;
  const cid = randomCid();
  const purchaseName = `P ${last}`; // differs from the person's name: the email is what suggests them

  const personId = await seedPerson({ fullName, email });
  const productId = await seedProduct();
  const purchaseId = await seedPurchase({
    productId,
    matchStatus: "unmatched",
    rawPersonName: purchaseName,
    rawEmail: email.toUpperCase(),
    rawCid: cid,
    rawMemberType: "Student",
  });

  await page.goto(`/club/${clubSlug}/admin/purchases`);
  const row = page.getByRole("row").filter({ hasText: purchaseName }).filter({ hasText: "xlsx_upload" });
  await expect(row.getByText("unmatched", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Match…" }).click();

  const panel = page.getByRole("row").filter({ hasText: "Suggestions" });
  await expect(panel).toContainText(`Match ${purchaseName} (CID ${cid}) to a person`);
  const suggestion = panel.getByRole("listitem").filter({ hasText: fullName });
  await expect(suggestion).toContainText("CID none");
  await expect(suggestion).toContainText("CID would fill a blank");
  await suggestion.getByRole("button", { name: "Select" }).click();

  const adopt = panel.getByRole("checkbox", { name: "Use this purchase's CID for them" });
  await expect(adopt).toBeChecked();
  await panel.getByRole("button", { name: `Match to ${fullName}` }).click();

  await expect(page.getByText(`Matched to ${fullName} and saved the purchase's CID.`)).toBeVisible();
  await expect(row.getByText("manual_matched", { exact: true })).toBeVisible();
  await expect(row.getByText(`(matched: ${fullName})`)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Suggestions" })).toHaveCount(0);

  const after = await purchase(purchaseId);
  expect(after.person_id).toBe(personId);
  expect(after.match_status).toBe("manual_matched");
  expect(after.manual_matched_by).toBe(acceptanceContext().email);
  expect(after.manual_matched_at).not.toBeNull();
  expect(await person(personId)).toEqual({ cid, cid_source: "purchase" });
});

test("(c) a flagged conflict between two sso people is listed, 'Keep current' clears it and the sessions badge", async ({
  signedIn: page,
}) => {
  const { clubSlug, clubId } = acceptanceContext();
  const holderName = `Holder ${surname()}`;
  const claimantName = `Claimant ${surname()}`;
  const holderCid = randomCid();
  let claimantCid = randomCid();
  while (claimantCid === holderCid) claimantCid = randomCid();

  const holderId = await seedPerson({
    fullName: holderName,
    email: `holder.${randomHex(3)}@example.test`,
    cid: holderCid,
    cidSource: "sso",
  });
  const claimantId = await seedPerson({
    fullName: claimantName,
    email: `claimant.${randomHex(3)}@example.test`,
    cid: claimantCid,
    cidSource: "sso",
  });
  // What the CSV path records when a row with the claimant's email carries the holder's CID.
  const { data: conflict, error } = await adminDb
    .from("person_identity_conflict")
    .insert({
      club_id: clubId,
      person_id: claimantId,
      existing_cid: claimantCid,
      existing_source: "sso",
      incoming_cid: holderCid,
      incoming_source: "sso",
      other_person_id: holderId,
      outcome: "flagged",
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw error;

  // The sessions page link shows one open conflict.
  await page.goto(`/club/${clubSlug}/sessions`);
  const reviewLink = page.getByRole("link", { name: /People review/ });
  await expect(reviewLink).toContainText("1 open");

  await reviewLink.click();
  await expect(page.getByRole("heading", { name: "People review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open CID conflicts (1)" })).toBeVisible();
  const rowEl = page.getByTestId("conflict-row");
  await expect(rowEl).toHaveCount(1);
  await expect(rowEl).toContainText(claimantName);
  await expect(rowEl).toContainText(`${claimantCid} (sso)`);
  await expect(rowEl).toContainText(`${holderCid} (sso)`);
  await expect(rowEl).toContainText("Held by");
  await expect(rowEl).toContainText(`${holderName} (sso)`);
  // Equal rank holder: neither "Use incoming" nor "Take" is offered.
  await expect(rowEl.getByRole("button", { name: "Use incoming" })).toHaveCount(0);
  await expect(rowEl.getByRole("button", { name: /Take this CID/ })).toHaveCount(0);

  await rowEl.getByRole("button", { name: "Keep current" }).click();
  await expect(page.getByText("Kept the current CID.")).toBeVisible();
  await expect(page.getByTestId("conflict-row")).toHaveCount(0);
  await expect(page.getByText("No open CID conflicts.")).toBeVisible();

  const { data: stored, error: readError } = await adminDb
    .from("person_identity_conflict")
    .select("status, resolved_by")
    .eq("id", conflict.id)
    .single();
  if (readError) throw readError;
  expect(stored.status).toBe("dismissed");
  expect(await person(claimantId)).toEqual({ cid: claimantCid, cid_source: "sso" });
  expect(await person(holderId)).toEqual({ cid: holderCid, cid_source: "sso" });

  await page.goto(`/club/${clubSlug}/sessions`);
  await expect(page.getByRole("link", { name: /People review/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /People review/ })).not.toContainText("open");
});

test("(d) a same-name pair is listed and 'Not the same person' hides it for good", async ({ signedIn: page }) => {
  const { clubId } = acceptanceContext();
  const name = `Jordan ${surname()}`;
  await seedPerson({ fullName: name, email: `jordan.a.${randomHex(3)}@example.test` });
  await seedPerson({ fullName: ` ${name.toUpperCase()} `, email: `jordan.b.${randomHex(3)}@example.test` });

  await openReview(page);
  const group = page.getByTestId("same-name-group").filter({ hasText: name });
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("(2)");
  await expect(group).toContainText("0 attendances");

  await group.getByRole("button", { name: "Not the same person" }).click();
  await expect(page.getByText("Marked as different people.")).toBeVisible();
  await expect(page.getByTestId("same-name-group").filter({ hasText: name })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "People review" })).toBeVisible();
  await expect(page.getByTestId("same-name-group").filter({ hasText: name })).toHaveCount(0);

  const { data, error } = await adminDb
    .from("person_duplicate_dismissal")
    .select("name_key")
    .eq("club_id", clubId);
  if (error) throw error;
  expect(data).toEqual([{ name_key: name.toLowerCase() }]);
});

test("(e) the walk-in form rejects a one-word name and a 5-digit CID, then stores a valid walk-in", async ({
  signedIn: page,
}) => {
  const { clubSlug, clubId } = acceptanceContext();
  const title = `Walk-in night ${randomHex(3)}`;
  const sessionId = await seedSession({ title, startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

  await page.goto(`/club/${clubSlug}/sessions/${sessionId}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "Add someone not on the list" }).click();
  await page.getByRole("button", { name: "None of these — create new person" }).click();

  const nameInput = page.getByLabel("Full name");
  const emailInput = page.getByLabel("Email (required)");
  const cidInput = page.getByLabel(/^CID/);
  const submit = page.getByRole("button", { name: "Add walk-in" });

  const last = surname();
  const email = `sean.${last.toLowerCase()}@example.test`;
  await nameInput.fill("Sean");
  await emailInput.fill(email);
  await expect(page.locator("#walkin-name-error")).toHaveText("Enter first name and surname");
  await expect(nameInput).toHaveAttribute("aria-invalid", "true");
  await expect(submit).toBeDisabled();

  await nameInput.fill(`Sean ${last}`);
  await expect(page.locator("#walkin-name-error")).toHaveCount(0);
  await cidInput.fill("12345");
  await expect(page.locator("#walkin-cid-error")).toHaveText("CID is 8 digits, or 7 if you leave off the leading 0");
  await expect(submit).toBeDisabled();

  const sevenDigitCid = String(randomInt(1_000_000, 10_000_000));
  await cidInput.fill(sevenDigitCid);
  await expect(page.locator("#walkin-cid-error")).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByText(`Added Sean ${last} as a walk-in`)).toBeVisible();

  const { data, error } = await adminDb
    .from("person")
    .select("full_name, cid, cid_source, identity_confidence")
    .eq("club_id", clubId)
    .eq("email", email);
  if (error) throw error;
  expect(data).toEqual([
    { full_name: `Sean ${last}`, cid: `0${sevenDigitCid}`, cid_source: "walk_in", identity_confidence: "provisional" },
  ]);
});
