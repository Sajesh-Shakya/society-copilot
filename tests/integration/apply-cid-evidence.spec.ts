import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { applyCidEvidence } from "@/lib/identity/apply-cid-evidence";
import type { CidSource } from "@/lib/identity/cid-rule";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("applyCidEvidence", () => {
  let personIds: string[] = [];
  const runId = Date.now().toString(36);
  let n = 0;

  test.afterEach(async () => {
    if (personIds.length) {
      await admin.from("person_identity_conflict").delete().in("person_id", personIds);
      await admin.from("person_identity_conflict").delete().in("other_person_id", personIds);
      await admin.from("person").delete().in("id", personIds);
    }
    personIds = [];
  });

  /** A CID unique to this run, so it never collides with real members. */
  function testCid(tag: string) {
    return `T${runId}${tag}`;
  }

  async function makePerson(club: string, cid: string | null = null, cidSource: CidSource | null = null) {
    n += 1;
    const { data, error } = await admin
      .from("person")
      .insert({
        club_id: club,
        full_name: "Apply CID Evidence Test",
        email: `apply-cid-${runId}-${n}@example.test`,
        cid,
        cid_source: cidSource,
      })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(data.id);
    return data.id as string;
  }

  async function person(id: string) {
    const { data, error } = await admin.from("person").select("cid, cid_source").eq("id", id).single();
    if (error) throw error;
    return data as { cid: string | null; cid_source: string | null };
  }

  async function conflicts(personId: string) {
    const { data, error } = await admin
      .from("person_identity_conflict")
      .select("*")
      .eq("person_id", personId)
      .order("created_at");
    if (error) throw error;
    return data as Array<Record<string, unknown>>;
  }

  test("a person with no CID gets the incoming CID and source", async () => {
    const judo = await clubId("judo");
    const p = await makePerson(judo);
    const cid = testCid("a");

    const res = await applyCidEvidence(createClubScopedClient(judo), p, cid, "purchase");

    expect(res).toEqual({ decision: "set", cidChanged: true });
    expect(await person(p)).toEqual({ cid, cid_source: "purchase" });
    expect(await conflicts(p)).toHaveLength(0);
  });

  test("sso evidence overwrites a walk-in CID and logs a resolved conflict", async () => {
    const judo = await clubId("judo");
    const oldCid = testCid("w");
    const newCid = testCid("s");
    const p = await makePerson(judo, oldCid, "walk_in");

    const res = await applyCidEvidence(createClubScopedClient(judo), p, newCid, "sso");

    expect(res).toEqual({ decision: "overwrite", cidChanged: true });
    expect(await person(p)).toEqual({ cid: newCid, cid_source: "sso" });
    const rows = await conflicts(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      club_id: judo,
      existing_cid: oldCid,
      existing_source: "walk_in",
      incoming_cid: newCid,
      incoming_source: "sso",
      outcome: "overwritten",
      status: "resolved",
      other_person_id: null,
    });
  });

  test("lower-ranked purchase evidence against an sso CID is ignored once, even when repeated", async () => {
    const judo = await clubId("judo");
    const ssoCid = testCid("x");
    const p = await makePerson(judo, ssoCid, "sso");
    const scoped = createClubScopedClient(judo);

    const first = await applyCidEvidence(scoped, p, testCid("y"), "purchase");
    const second = await applyCidEvidence(scoped, p, testCid("y"), "purchase");

    expect(first).toEqual({ decision: "ignore", cidChanged: false });
    expect(second).toEqual({ decision: "ignore", cidChanged: false });
    expect(await person(p)).toEqual({ cid: ssoCid, cid_source: "sso" });
    const rows = await conflicts(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "ignored", status: "resolved", incoming_source: "purchase" });
  });

  test("equal-rank different CIDs are flagged open, once, even when repeated", async () => {
    const judo = await clubId("judo");
    const ssoCid = testCid("x");
    const p = await makePerson(judo, ssoCid, "sso");
    const scoped = createClubScopedClient(judo);

    const first = await applyCidEvidence(scoped, p, testCid("z"), "sso");
    const second = await applyCidEvidence(scoped, p, testCid("z"), "sso");

    expect(first).toEqual({ decision: "flag", cidChanged: false });
    expect(second).toEqual({ decision: "flag", cidChanged: false });
    expect(await person(p)).toEqual({ cid: ssoCid, cid_source: "sso" });
    const rows = await conflicts(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "flagged",
      status: "open",
      existing_cid: ssoCid,
      existing_source: "sso",
      incoming_cid: testCid("z"),
      other_person_id: null,
    });
  });

  test("a CID already owned by another person is flagged with other_person_id and not applied", async () => {
    const judo = await clubId("judo");
    const held = testCid("h");
    const holder = await makePerson(judo, held, "sso");
    const p = await makePerson(judo);

    const res = await applyCidEvidence(createClubScopedClient(judo), p, held, "sso");

    expect(res).toEqual({ decision: "flag", cidChanged: false });
    expect(await person(p)).toEqual({ cid: null, cid_source: null });
    expect(await person(holder)).toEqual({ cid: held, cid_source: "sso" });
    const rows = await conflicts(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "flagged", status: "open", other_person_id: holder, incoming_cid: held });
  });

  test("equal-rank evidence for a CID another person holds records that holder as other_person_id", async () => {
    const judo = await clubId("judo");
    const cidX = testCid("x");
    const cidY = testCid("y");
    const a = await makePerson(judo, cidX, "sso");
    const b = await makePerson(judo, cidY, "sso");

    const res = await applyCidEvidence(createClubScopedClient(judo), a, cidY, "sso");

    expect(res).toEqual({ decision: "flag", cidChanged: false });
    expect(await person(a)).toEqual({ cid: cidX, cid_source: "sso" });
    expect(await person(b)).toEqual({ cid: cidY, cid_source: "sso" });
    const rows = await conflicts(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "flagged", status: "open", other_person_id: b });
  });

  test("lower-ranked evidence for a CID another person holds is ignored without other_person_id", async () => {
    const judo = await clubId("judo");
    const cidX = testCid("x");
    const cidY = testCid("y");
    const a = await makePerson(judo, cidX, "sso");
    await makePerson(judo, cidY, "sso");

    const res = await applyCidEvidence(createClubScopedClient(judo), a, cidY, "walk_in");

    expect(res).toEqual({ decision: "ignore", cidChanged: false });
    const rows = await conflicts(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "ignored", other_person_id: null });
  });

  test("the same CID from a higher source raises cid_source without a conflict", async () => {
    const judo = await clubId("judo");
    const cid = testCid("c");
    const p = await makePerson(judo, cid, "walk_in");
    const scoped = createClubScopedClient(judo);

    const res = await applyCidEvidence(scoped, p, cid, "sso");
    expect(res).toEqual({ decision: "confirm", cidChanged: false });
    expect(await person(p)).toEqual({ cid, cid_source: "sso" });

    const lower = await applyCidEvidence(scoped, p, cid, "purchase");
    expect(lower).toEqual({ decision: "confirm", cidChanged: false });
    expect(await person(p)).toEqual({ cid, cid_source: "sso" });
    expect(await conflicts(p)).toHaveLength(0);
  });

  test("a person from another club is not found through the scoped client", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const p = await makePerson(taekwondo);

    await expect(applyCidEvidence(createClubScopedClient(judo), p, testCid("q"), "sso")).rejects.toThrow();
    expect(await person(p)).toEqual({ cid: null, cid_source: null });
  });
});
