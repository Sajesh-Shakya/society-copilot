import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { mergePeople } from "@/lib/identity/merge";

// Throwaway club only: never touches real judo/taekwondo rows.
const admin = createAdminClient();
let clubId: string;
let otherClubId: string;
const DAY = 24 * 60 * 60 * 1000;

test.beforeEach(async () => {
  const mk = async () => {
    const { data, error } = await admin
      .from("club")
      .insert({ slug: `mp-${randomUUID().slice(0, 8)}`, name: "Merge Throwaway Club" })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  };
  clubId = await mk();
  otherClubId = await mk();
});

test.afterEach(async () => {
  for (const id of [clubId, otherClubId]) {
    for (const t of ["person_merge_log", "chase_email", "attendance_record", "purchase", "product", "person_identity_conflict", "session", "person"]) {
      const { error } = await admin.from(t).delete().eq("club_id", id);
      if (error) throw new Error(`Cleanup ${t}: ${error.message}`);
    }
    await admin.from("club").delete().eq("id", id);
  }
});

async function person(cid: string, name = "Merge Twin", extra: Record<string, unknown> = {}, club = clubId) {
  const { data, error } = await admin
    .from("person")
    .insert({ club_id: club, full_name: name, email: `mp-${randomUUID()}@example.test`, ...extra })
    .select("id")
    .single();
  if (error) throw error;
  void cid;
  return data.id as string;
}

async function session(daysAgo: number) {
  const { data, error } = await admin
    .from("session")
    .insert({ club_id: clubId, title: "MP Session", starts_at: new Date(Date.now() - daysAgo * DAY).toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function attend(personId: string, sessionId: string, attended: boolean) {
  const { error } = await admin
    .from("attendance_record")
    .insert({ club_id: clubId, person_id: personId, session_id: sessionId, source: "manual_tick", attended });
  if (error) throw error;
}

test("merging moves attendance, purchases and chase emails to the kept person and deletes the duplicate", async () => {
  const keep = await person("a");
  const dupe = await person("b");
  const shared = await session(20);
  const onlyDupe = await session(10);
  await attend(keep, shared, false);
  await attend(dupe, shared, true); // either record attended => merged record attended
  await attend(dupe, onlyDupe, true);

  const { data: prod } = await admin
    .from("product")
    .insert({ club_id: clubId, name: "MP Product", kind: "session_pass", covers_sessions: 1 })
    .select("id")
    .single();
  const { error: pe } = await admin.from("purchase").insert({
    club_id: clubId, person_id: dupe, product_id: prod!.id, source: "xlsx_upload", source_row_id: `mp-${randomUUID()}`,
    purchased_at: new Date().toISOString(), match_status: "manual_matched",
  });
  if (pe) throw pe;
  const cycle = new Date(Date.now() - 15 * DAY).toISOString();
  for (const p of [keep, dupe]) {
    const { error } = await admin.from("chase_email").insert({
      club_id: clubId, person_id: p, debt_cycle_started_at: cycle, sequence_number: 1,
      status: "pending_approval", subject: "s", body: "b",
    });
    if (error) throw error;
  }

  const result = await mergePeople(clubId, keep, [dupe], "admin@example.test");
  expect(result.merged).toBe(1);

  const { data: people } = await admin.from("person").select("id").eq("club_id", clubId);
  expect(people!.map((p) => p.id)).toEqual([keep]);
  const { data: att } = await admin.from("attendance_record").select("session_id, attended").eq("person_id", keep);
  expect(att).toHaveLength(2);
  expect(att!.find((a) => a.session_id === shared)!.attended).toBe(true);
  const { data: purchases } = await admin.from("purchase").select("id").eq("person_id", keep);
  expect(purchases).toHaveLength(1);
  const { data: chase } = await admin.from("chase_email").select("sequence_number").eq("person_id", keep).order("sequence_number");
  expect(chase!.map((c) => c.sequence_number)).toEqual([1, 2]); // collision renumbered, nothing lost
  const { data: log } = await admin.from("person_merge_log").select("kept_person_id, merged_by").eq("club_id", clubId);
  expect(log).toEqual([{ kept_person_id: keep, merged_by: "admin@example.test" }]);
});

test("merge carries over a CID the kept person lacks, and exempt status", async () => {
  const keep = await person("a");
  const dupe = await person("b", "Merge Twin", { cid: `mp${randomUUID().slice(0, 8)}`, cid_source: "sso", is_exempt: true });
  const { data: before } = await admin.from("person").select("cid").eq("id", dupe).single();
  await mergePeople(clubId, keep, [dupe], "admin@example.test");
  const { data: kept } = await admin.from("person").select("cid, is_exempt").eq("id", keep).single();
  expect(kept).toEqual({ cid: before!.cid, is_exempt: true });
});

test("merge refuses people from another club, or keeping a person while merging them into themselves", async () => {
  const keep = await person("a");
  const foreign = await person("b", "Merge Twin", {}, otherClubId);
  await expect(mergePeople(clubId, keep, [foreign], "admin@example.test")).rejects.toThrow();
  await expect(mergePeople(clubId, keep, [keep], "admin@example.test")).rejects.toThrow();
  const { data } = await admin.from("person").select("id").eq("id", foreign);
  expect(data).toHaveLength(1);
});
