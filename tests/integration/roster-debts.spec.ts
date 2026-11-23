import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRosterDebts } from "@/lib/attendance/debt";

// Throwaway club only: never touches real judo/taekwondo rows.
const admin = createAdminClient();
const DAY = 24 * 60 * 60 * 1000;
let clubId: string;

test.beforeEach(async () => {
  const { data, error } = await admin
    .from("club")
    .insert({ slug: `rd-${randomUUID().slice(0, 8)}`, name: "Roster Debts Throwaway Club" })
    .select("id")
    .single();
  if (error) throw error;
  clubId = data.id;
});

test.afterEach(async () => {
  for (const t of ["attendance_record", "session", "person"]) {
    const { error } = await admin.from(t).delete().eq("club_id", clubId);
    if (error) throw new Error(`Cleanup ${t}: ${error.message}`);
  }
  await admin.from("club").delete().eq("id", clubId);
});

async function person(name: string, exempt = false) {
  const { data, error } = await admin
    .from("person")
    .insert({ club_id: clubId, full_name: name, email: `rd-${randomUUID()}@example.test`, is_exempt: exempt })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function attend(personId: string, daysAgo: number, attended = true) {
  const { data: s, error } = await admin
    .from("session")
    .insert({ club_id: clubId, title: "RD Session", starts_at: new Date(Date.now() - daysAgo * DAY).toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  const { error: ae } = await admin
    .from("attendance_record")
    .insert({ club_id: clubId, person_id: personId, session_id: s.id, source: "manual_tick", attended });
  if (ae) throw ae;
}

test("getRosterDebts counts unpaid attended sessions per person (first one is free)", async () => {
  const owes = await person("RD Owes");
  const clear = await person("RD Clear");
  const exempt = await person("RD Exempt", true);
  for (const d of [30, 20, 10]) await attend(owes, d); // first free -> 2 unpaid
  await attend(clear, 5);
  for (const d of [30, 20, 10]) await attend(exempt, d);

  const debts = await getRosterDebts(clubId, [owes, clear, exempt]);
  expect(debts[owes]).toBe(2);
  expect(debts[clear] ?? 0).toBe(0);
  expect(debts[exempt] ?? 0).toBe(0);
});

test("getRosterDebts rises by one when another session is ticked attended", async () => {
  const p = await person("RD Ticker");
  for (const d of [30, 20]) await attend(p, d);
  expect((await getRosterDebts(clubId, [p]))[p] ?? 0).toBe(1);
  await attend(p, 1);
  expect((await getRosterDebts(clubId, [p]))[p]).toBe(2);
});

test("getRosterDebts of an empty roster is empty", async () => {
  expect(await getRosterDebts(clubId, [])).toEqual({});
});
