import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateChaseEmails } from "@/lib/chase/generator";
import { processAutoSends } from "@/lib/chase/send";
import {
  grantStandingApproval,
  revokeStandingApproval,
  approveChaseEmailAndRemember,
} from "@/lib/chase/approval-writer";
import type { EmailChannelAdapter } from "@/lib/email/types";

// Runs against a THROWAWAY club, not judo: generateChaseEmails and
// processAutoSends act on every debtor / approved row in the club, and a fake
// adapter would otherwise mark real judo rows as "sent".
const admin = createAdminClient();
const DAY = 24 * 60 * 60 * 1000;
let clubId: string;
let personIds: string[] = [];
let sessionIds: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test.beforeEach(async () => {
  const { data, error } = await admin
    .from("club")
    .insert({ slug: `sa-${randomUUID().slice(0, 8)}`, name: "Standing Approval Throwaway Club" })
    .select("id")
    .single();
  if (error) throw error;
  clubId = data.id;
  setEnv("CHASE_AUTO_SEND_REPEATS", "true");
});

test.afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  const steps: [string, () => PromiseLike<{ error: { message: string } | null }>][] = [
    ["chase_email", () => admin.from("chase_email").delete().eq("club_id", clubId)],
    ["attendance", () => admin.from("attendance_record").delete().eq("club_id", clubId)],
    ["session", () => admin.from("session").delete().eq("club_id", clubId)],
    ["person", () => admin.from("person").delete().eq("club_id", clubId)],
    ["club", () => admin.from("club").delete().eq("id", clubId)],
  ];
  personIds = [];
  sessionIds = [];
  for (const [name, fn] of steps) {
    const { error } = await fn();
    if (error) throw new Error(`Cleanup ${name}: ${error.message}`);
  }
});

async function debtor() {
  const { data, error } = await admin
    .from("person")
    .insert({ club_id: clubId, full_name: "SA Debtor", email: `sa-${randomUUID()}@example.test`, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  const personId = data.id as string;
  personIds.push(personId);
  for (const daysAgo of [30, 25, 20]) {
    const { data: s, error: se } = await admin
      .from("session")
      .insert({ club_id: clubId, title: "SA Session", starts_at: new Date(Date.now() - daysAgo * DAY).toISOString() })
      .select("id")
      .single();
    if (se) throw se;
    sessionIds.push(s.id);
    const { error: ae } = await admin
      .from("attendance_record")
      .insert({ club_id: clubId, person_id: personId, session_id: s.id, source: "manual_tick" });
    if (ae) throw ae;
  }
  return personId;
}

async function chaseRow(personId: string) {
  const { data, error } = await admin.from("chase_email").select("*").eq("person_id", personId).order("sequence_number");
  if (error) throw error;
  return data;
}

function fakeAdapter() {
  const sent: string[] = [];
  const adapter: EmailChannelAdapter = {
    async send(input) {
      sent.push(input.to);
      return { providerMessageId: `fake-${randomUUID()}` };
    },
  };
  return { adapter, sent };
}

test("standing approval makes the generator create an approved, auto_approved first email", async () => {
  const a = await debtor();
  const b = await debtor();
  expect(await grantStandingApproval(a, clubId, "admin@example.test")).toEqual({ granted: true });
  await generateChaseEmails(clubId);
  const [rowA] = await chaseRow(a);
  expect(rowA).toMatchObject({ status: "approved", auto_approved: true, sequence_number: 1 });
  expect(rowA.approved_by).toBe("standing:admin@example.test");
  const [rowB] = await chaseRow(b);
  expect(rowB).toMatchObject({ status: "pending_approval", auto_approved: false });
});

test("exempt people cannot be granted standing approval", async () => {
  const a = await debtor();
  await admin.from("person").update({ is_exempt: true }).eq("id", a);
  expect(await grantStandingApproval(a, clubId, "admin@example.test")).toEqual({ granted: false });
});

test("exempted after generation: send is cancelled, nothing sent", async () => {
  const a = await debtor();
  await grantStandingApproval(a, clubId, "admin@example.test");
  await generateChaseEmails(clubId);
  await admin.from("person").update({ is_exempt: true }).eq("id", a);
  const { adapter, sent } = fakeAdapter();
  const result = await processAutoSends(clubId, adapter);
  expect(sent).toHaveLength(0);
  expect(result.cancelled).toBe(1);
  expect((await chaseRow(a))[0].status).toBe("cancelled");
});

test("revoked after generation: row cancelled with note, nothing sent", async () => {
  const a = await debtor();
  await grantStandingApproval(a, clubId, "admin@example.test");
  await generateChaseEmails(clubId);
  expect(await revokeStandingApproval(a, clubId)).toEqual({ revoked: true });
  const { adapter, sent } = fakeAdapter();
  const result = await processAutoSends(clubId, adapter);
  expect(sent).toHaveLength(0);
  expect(result.cancelled).toBe(1);
  const [row] = await chaseRow(a);
  expect(row.status).toBe("cancelled");
  expect(row.note).toContain("standing approval no longer valid");
});

test("paused club sends nothing and leaves rows approved; unpausing resumes", async () => {
  const a = await debtor();
  await grantStandingApproval(a, clubId, "admin@example.test");
  await generateChaseEmails(clubId);
  await admin.from("club").update({ chase_auto_send_paused: true }).eq("id", clubId);
  const first = fakeAdapter();
  expect(await processAutoSends(clubId, first.adapter)).toEqual({ sent: 0, cancelled: 0, failed: 0, skipped: 0 });
  expect(first.sent).toHaveLength(0);
  expect((await chaseRow(a))[0].status).toBe("approved");
  await admin.from("club").update({ chase_auto_send_paused: false }).eq("id", clubId);
  const second = fakeAdapter();
  const result = await processAutoSends(clubId, second.adapter);
  expect(result.sent).toBe(1);
  expect((await chaseRow(a))[0].status).toBe("sent");
});

test("per-run cap sends exactly the cap; the rest stay approved", async () => {
  setEnv("CHASE_AUTO_SEND_MAX_PER_RUN", "2");
  const people = [await debtor(), await debtor(), await debtor()];
  for (const p of people) await grantStandingApproval(p, clubId, "admin@example.test");
  await generateChaseEmails(clubId);
  const { adapter, sent } = fakeAdapter();
  const result = await processAutoSends(clubId, adapter);
  expect(sent).toHaveLength(2);
  expect(result).toMatchObject({ sent: 2, skipped: 1 });
  const rows = (await Promise.all(people.map(chaseRow))).flat();
  expect(rows.filter((r) => r.status === "approved")).toHaveLength(1);
});

test("without the global flag standing approval does nothing", async () => {
  setEnv("CHASE_AUTO_SEND_REPEATS", undefined);
  const a = await debtor();
  await grantStandingApproval(a, clubId, "admin@example.test");
  await generateChaseEmails(clubId);
  expect((await chaseRow(a))[0]).toMatchObject({ status: "pending_approval", auto_approved: false });
  const { adapter, sent } = fakeAdapter();
  expect(await processAutoSends(clubId, adapter)).toEqual({ sent: 0, cancelled: 0, failed: 0, skipped: 0 });
  expect(sent).toHaveLength(0);
});

test("approveChaseEmailAndRemember approves the email and records standing approval", async () => {
  const a = await debtor();
  await generateChaseEmails(clubId);
  const [row] = await chaseRow(a);
  expect(row.status).toBe("pending_approval");
  expect(await approveChaseEmailAndRemember(row.id, clubId, "admin@example.test")).toEqual({ approved: true });
  expect((await chaseRow(a))[0].status).toBe("approved");
  const { data: person } = await admin.from("person").select("chase_auto_approved_at, chase_auto_approved_by").eq("id", a).single();
  expect(person!.chase_auto_approved_by).toBe("admin@example.test");
  expect(person!.chase_auto_approved_at).not.toBeNull();
});
