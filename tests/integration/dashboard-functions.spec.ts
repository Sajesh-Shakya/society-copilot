import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { getDashboard } from "@/lib/dashboard/queries";

const admin = createAdminClient();
let judoClubId: string;

// Throwaway data lives in 2099 so real rows can never fall in range.
const RANGE_START = "2099-01-01T00:00:00Z";
const RANGE_END = "2099-12-31T00:00:00Z";

test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judoClubId = data.id;
});

let sessionIds: string[] = [];
let personIds: string[] = [];
let productIds: string[] = [];
let clubIds: string[] = [];

test.afterEach(async () => {
  const steps: [string, () => PromiseLike<{ error: { message: string } | null }>][] = [];
  const [sessions, people, products, clubs] = [sessionIds, personIds, productIds, clubIds];
  if (sessionIds.length) steps.push(["attendance", () => admin.from("attendance_record").delete().in("session_id", sessions)]);
  if (productIds.length) steps.push(["purchase", () => admin.from("purchase").delete().in("product_id", products)]);
  if (sessionIds.length) steps.push(["session", () => admin.from("session").delete().in("id", sessions)]);
  if (personIds.length) steps.push(["person", () => admin.from("person").delete().in("id", people)]);
  if (productIds.length) steps.push(["product", () => admin.from("product").delete().in("id", products)]);
  if (clubIds.length) steps.push(["club", () => admin.from("club").delete().in("id", clubs)]);
  sessionIds = []; personIds = []; productIds = []; clubIds = [];
  for (const [name, fn] of steps) {
    const { error } = await fn();
    if (error) throw new Error(`Cleanup ${name}: ${error.message}`);
  }
});

async function makeSession(clubId: string, startsAt: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("session")
    .insert({ club_id: clubId, title: `Dash Test ${randomUUID()}`, starts_at: startsAt, ...extra })
    .select("id")
    .single();
  if (error) throw error;
  sessionIds.push(data.id);
  return data.id as string;
}

async function makePerson(clubId: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("person")
    .insert({ club_id: clubId, full_name: "Dash Person", email: `dash-${randomUUID()}@example.test`, ...extra })
    .select("id")
    .single();
  if (error) throw error;
  personIds.push(data.id);
  return data.id as string;
}

async function attend(clubId: string, personId: string, sessionId: string, attended: boolean) {
  const { error } = await admin
    .from("attendance_record")
    .insert({ club_id: clubId, person_id: personId, session_id: sessionId, source: "manual_tick", attended });
  if (error) throw error;
}

async function makeProduct(clubId: string) {
  const { data, error } = await admin
    .from("product")
    .insert({ club_id: clubId, name: `Dash Product ${randomUUID()}`, kind: "other" })
    .select("id")
    .single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id as string;
}

async function addPurchase(clubId: string, productId: string, pricePence: number | null, purchasedAt: string) {
  const { error } = await admin.from("purchase").insert({
    club_id: clubId,
    product_id: productId,
    source: "xlsx_upload",
    source_row_id: `dash-${randomUUID()}`,
    purchased_at: purchasedAt,
    match_status: "unmatched",
    price_pence: pricePence,
  });
  if (error) throw error;
}

type SignupRow = { session_id: string; title: string; starts_at: string; signups: number; attended: number };

async function signups(clubId: string) {
  const { data, error } = await createClubScopedClient(clubId).rpc("dashboard_signups", {
    range_start: RANGE_START,
    range_end: RANGE_END,
  });
  if (error) throw error;
  return data as SignupRow[];
}

async function revenue(clubId: string) {
  const { data, error } = await createClubScopedClient(clubId).rpc("dashboard_revenue", {
    range_start: RANGE_START,
    range_end: RANGE_END,
  });
  if (error) throw error;
  return data as { product_id: string; purchases: number; unpriced: number; revenue_pence: number }[];
}

type Owed = { sessions: number; people: number; bucket_0_14: number; bucket_15_30: number; bucket_31_plus: number };
async function owed(clubId: string): Promise<Owed> {
  const { data, error } = await createClubScopedClient(clubId).rpc("dashboard_money_owed");
  if (error) throw error;
  const rows = data as Owed[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

test("dashboard_signups counts signups and attended, skips cancelled, includes empty sessions", async () => {
  const s1 = await makeSession(judoClubId, "2099-03-01T18:00:00Z");
  const s2 = await makeSession(judoClubId, "2099-03-08T18:00:00Z");
  const cancelled = await makeSession(judoClubId, "2099-03-15T18:00:00Z", { cancelled_at: new Date().toISOString() });
  const p1 = await makePerson(judoClubId);
  const p2 = await makePerson(judoClubId);
  await attend(judoClubId, p1, s1, true);
  await attend(judoClubId, p2, s1, false);
  await attend(judoClubId, p1, cancelled, true);

  const rows = await signups(judoClubId);
  const byId = new Map(rows.map((r) => [r.session_id, r]));
  expect(byId.get(s1)).toMatchObject({ signups: 2, attended: 1 });
  expect(byId.get(s2)).toMatchObject({ signups: 0, attended: 0 });
  expect(byId.has(cancelled)).toBe(false);
  // ordered by starts_at desc
  expect(rows.map((r) => r.starts_at)).toEqual([...rows.map((r) => r.starts_at)].sort().reverse());
});

test("dashboard_revenue sums priced rows, counts unpriced, respects range", async () => {
  const product = await makeProduct(judoClubId);
  await addPurchase(judoClubId, product, 500, "2099-02-01T00:00:00Z");
  await addPurchase(judoClubId, product, 800, "2099-02-02T00:00:00Z");
  await addPurchase(judoClubId, product, null, "2099-02-03T00:00:00Z");
  await addPurchase(judoClubId, product, 999, "2100-02-03T00:00:00Z"); // out of range

  const row = (await revenue(judoClubId)).find((r) => r.product_id === product)!;
  expect(row).toMatchObject({ purchases: 3, unpriced: 1, revenue_pence: 1300 });
});

test("dashboard functions never include another club's rows", async () => {
  const { data: other, error } = await admin
    .from("club")
    .insert({ slug: `dash-${randomUUID().slice(0, 8)}`, name: "Dash Throwaway Club" })
    .select("id")
    .single();
  if (error) throw error;
  clubIds.push(other.id);

  const otherSession = await makeSession(other.id, "2099-04-01T18:00:00Z");
  const otherProduct = await makeProduct(other.id);
  await addPurchase(other.id, otherProduct, 700, "2099-04-01T00:00:00Z");

  expect((await signups(judoClubId)).some((r) => r.session_id === otherSession)).toBe(false);
  expect((await revenue(judoClubId)).some((r) => r.product_id === otherProduct)).toBe(false);
  expect((await signups(other.id)).some((r) => r.session_id === otherSession)).toBe(true);
  expect((await revenue(other.id)).find((r) => r.product_id === otherProduct)?.revenue_pence).toBe(700);
});

test("dashboard_money_owed counts sessions, people and age bucket; ignores exempt people", async () => {
  const before = await owed(judoClubId);
  const day = 24 * 60 * 60 * 1000;
  const debtor = await makePerson(judoClubId);
  const exempt = await makePerson(judoClubId, { is_exempt: true });
  for (const daysAgo of [20, 15, 10]) {
    const sid = await makeSession(judoClubId, new Date(Date.now() - daysAgo * day).toISOString());
    await attend(judoClubId, debtor, sid, true);
    await attend(judoClubId, exempt, sid, true);
  }

  const { data: cycle, error } = await admin
    .from("active_debt_cycle")
    .select("debt_count, debt_cycle_started_at")
    .eq("person_id", debtor)
    .single();
  if (error) throw error;
  expect(cycle.debt_count).toBeGreaterThan(0);
  const ageDays = Math.floor((Date.now() - new Date(cycle.debt_cycle_started_at).getTime()) / day);
  const bucket = ageDays <= 14 ? "bucket_0_14" : ageDays <= 30 ? "bucket_15_30" : "bucket_31_plus";

  const after = await owed(judoClubId);
  expect(after.sessions - before.sessions).toBe(cycle.debt_count);
  expect(after.people - before.people).toBe(1);
  expect(after[bucket] - before[bucket]).toBe(1);
});

test("dashboard_money_owed returns a zero row for a club with no debt", async () => {
  const { data: other, error } = await admin
    .from("club")
    .insert({ slug: `dash-${randomUUID().slice(0, 8)}`, name: "Dash Empty Club" })
    .select("id")
    .single();
  if (error) throw error;
  clubIds.push(other.id);
  expect(await owed(other.id)).toEqual({ sessions: 0, people: 0, bucket_0_14: 0, bucket_15_30: 0, bucket_31_plus: 0 });
});

test("getDashboard aggregates averages, revenue and owed from the SQL functions", async () => {
  const before = await owed(judoClubId);
  const s1 = await makeSession(judoClubId, "2099-05-01T18:00:00Z");
  const s2 = await makeSession(judoClubId, "2099-05-08T18:00:00Z");
  await makeSession(judoClubId, "2099-05-15T18:00:00Z"); // no signups at all: must not appear
  const p1 = await makePerson(judoClubId);
  const p2 = await makePerson(judoClubId);
  const p3 = await makePerson(judoClubId);
  await attend(judoClubId, p1, s1, true);
  await attend(judoClubId, p2, s1, true);
  await attend(judoClubId, p3, s1, false);
  await attend(judoClubId, p1, s2, true);
  const product = await makeProduct(judoClubId);
  await addPurchase(judoClubId, product, 500, "2099-05-02T00:00:00Z");
  await addPurchase(judoClubId, product, null, "2099-05-03T00:00:00Z");

  const d = await getDashboard(judoClubId, { start: new Date(RANGE_START), end: new Date("2099-06-01T00:00:00Z") });
  expect(d.signups.map((s) => s.signups).sort()).toEqual([1, 3]);
  expect(d.averageSignups).toBe(2);
  expect(d.averageAttended).toBe(1.5);
  expect(d.totalRevenuePence).toBe(500);
  expect(d.unpricedPurchases).toBe(1);
  const afterOwed = await owed(judoClubId);
  expect(before.sessions).toBeLessThanOrEqual(afterOwed.sessions);
  expect(d.owed.sessions).toBe(afterOwed.sessions);
  expect(d.owed.people).toBe(afterOwed.people);
  expect(d.targets).toEqual({ signupTarget: 20, signupMin: 15 });
  expect(Array.isArray(d.singleSessionPrices)).toBe(true);
});

test("getDashboard on an empty range has null averages and no NaN", async () => {
  const d = await getDashboard(judoClubId, { start: new Date("2098-01-01T00:00:00Z"), end: new Date("2098-02-01T00:00:00Z") });
  expect(d.signups).toEqual([]);
  expect(d.averageSignups).toBeNull();
  expect(d.averageAttended).toBeNull();
  expect(d.totalRevenuePence).toBe(0);
});
