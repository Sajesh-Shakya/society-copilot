import { test as base, expect, type Page } from "@playwright/test";
import { adminDb, deleteClubData, randomHex, type AcceptanceContext } from "./db";

export { adminDb, expect };

/** The throwaway club/admin created by global-setup (env var, never on disk). */
export function acceptanceContext(): AcceptanceContext {
  const raw = process.env.ACCEPTANCE_CONTEXT;
  if (!raw) throw new Error("ACCEPTANCE_CONTEXT is not set: global-setup did not run");
  return JSON.parse(raw) as AcceptanceContext;
}

/** Deletes everything in the throwaway club except the club, admin row and auth user. */
export async function resetClubData(): Promise<void> {
  await deleteClubData(acceptanceContext().clubId);
}

export async function signInThroughLoginForm(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

type Fixtures = {
  /** A page already signed in (via the real /login form) as the throwaway admin. */
  signedIn: Page;
  /** Auto fixture: wipes the throwaway club's data after every test. */
  cleanup: void;
};

export const test = base.extend<Fixtures>({
  // The callback is named `provide`, not `use`, so eslint's react-hooks rule
  // does not mistake Playwright's fixture callback for React's `use` hook.
  signedIn: async ({ page }, provide) => {
    const { email, password, clubSlug } = acceptanceContext();
    await signInThroughLoginForm(page, email, password);
    await page.waitForURL(`**/club/${clubSlug}/sessions`);
    await provide(page);
  },
  cleanup: [
    async ({}, provide) => {
      await provide();
      await resetClubData();
    },
    { auto: true },
  ],
});

// ---------------------------------------------------------------- seed helpers
// Each stamps club_id of the throwaway club; resetClubData() removes them.

function clubId() {
  return acceptanceContext().clubId;
}

export async function seedPerson(input: {
  fullName: string;
  email: string;
  cid?: string;
  cidSource?: "sso" | "purchase" | "walk_in";
}): Promise<string> {
  const { data, error } = await adminDb
    .from("person")
    .insert({
      club_id: clubId(),
      full_name: input.fullName,
      email: input.email,
      cid: input.cid ?? null,
      cid_source: input.cidSource ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedSession(input: {
  title: string;
  startsAt: Date | string;
  endsAt?: Date | string;
  seriesId?: string;
}): Promise<string> {
  const iso = (d: Date | string) => (typeof d === "string" ? d : d.toISOString());
  const { data, error } = await adminDb
    .from("session")
    .insert({
      club_id: clubId(),
      title: input.title,
      starts_at: iso(input.startsAt),
      ends_at: input.endsAt ? iso(input.endsAt) : null,
      series_id: input.seriesId ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedSeries(title: string): Promise<string> {
  const { data, error } = await adminDb
    .from("session_series")
    .insert({ club_id: clubId(), title })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedAttended(sessionId: string, personId: string): Promise<void> {
  const { error } = await adminDb.from("attendance_record").insert({
    club_id: clubId(),
    session_id: sessionId,
    person_id: personId,
    attended: true,
    source: "manual_tick",
  });
  if (error) throw error;
}

export async function seedProduct(
  input: { name?: string; kind?: "session_pass" | "term_pass" | "annual_pass" | "other"; coversSessions?: number } = {}
): Promise<string> {
  const { data, error } = await adminDb
    .from("product")
    .insert({
      club_id: clubId(),
      name: input.name ?? `Product ${randomHex(3)}`,
      kind: input.kind ?? "session_pass",
      covers_sessions: input.coversSessions ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedPurchase(input: {
  productId: string;
  personId?: string;
  purchasedAt?: Date | string;
  matchStatus?: "cid_matched" | "email_matched" | "manual_matched" | "unmatched";
  rawPersonName?: string;
  rawCid?: string;
  rawEmail?: string;
  rawMemberType?: string;
}): Promise<string> {
  const at = input.purchasedAt ?? new Date();
  const { data, error } = await adminDb
    .from("purchase")
    .insert({
      club_id: clubId(),
      product_id: input.productId,
      person_id: input.personId ?? null,
      source: "xlsx_upload",
      source_row_id: `e2e-${randomHex(6)}`,
      purchased_at: typeof at === "string" ? at : at.toISOString(),
      match_status: input.matchStatus ?? (input.personId ? "manual_matched" : "unmatched"),
      raw_person_name: input.rawPersonName ?? null,
      raw_cid: input.rawCid ?? null,
      raw_email: input.rawEmail ?? null,
      raw_member_type: input.rawMemberType ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}
