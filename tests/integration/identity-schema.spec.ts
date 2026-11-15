import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";

const admin = createAdminClient();

async function clubId(slug: "judo" | "taekwondo") {
  const { data, error } = await admin.from("club").select("id").eq("slug", slug).single();
  if (error) throw error;
  return data.id as string;
}

test.describe("identity trust schema", () => {
  let personIds: string[] = [];
  let dismissalIds: string[] = [];
  const runId = Date.now().toString(36);
  let n = 0;

  test.afterEach(async () => {
    if (personIds.length) {
      await admin.from("person_identity_conflict").delete().in("person_id", personIds);
    }
    if (dismissalIds.length) await admin.from("person_duplicate_dismissal").delete().in("id", dismissalIds);
    if (personIds.length) await admin.from("person").delete().in("id", personIds);
    personIds = [];
    dismissalIds = [];
  });

  async function makePerson(club: string, extra: Record<string, unknown> = {}) {
    n += 1;
    const res = await admin
      .from("person")
      .insert({
        club_id: club,
        full_name: "Identity Schema Test",
        email: `identity-schema-${runId}-${n}@example.test`,
        ...extra,
      })
      .select("id")
      .single();
    if (res.data) personIds.push(res.data.id);
    return res;
  }

  async function makePersonOk(club: string) {
    const res = await makePerson(club);
    if (res.error) throw res.error;
    return res.data!.id as string;
  }

  test("person.cid_source only accepts sso, purchase, walk_in or null", async () => {
    const judo = await clubId("judo");

    const bogus = await makePerson(judo, { cid_source: "bogus" });
    expect(bogus.error).not.toBeNull();
    expect(bogus.error!.code).toBe("23514");

    for (const v of ["sso", "purchase", "walk_in", null]) {
      const ok = await makePerson(judo, { cid_source: v });
      expect(ok.error).toBeNull();
    }
  });

  test("a conflict row cannot reference a person from another club", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const tkdPerson = await makePersonOk(taekwondo);

    const res = await admin.from("person_identity_conflict").insert({
      club_id: judo,
      person_id: tkdPerson,
      incoming_cid: "01234567",
      incoming_source: "sso",
      outcome: "overwritten",
    });
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe("23503");

    const judoPerson = await makePersonOk(judo);
    const other = await admin.from("person_identity_conflict").insert({
      club_id: judo,
      person_id: judoPerson,
      other_person_id: tkdPerson,
      incoming_cid: "01234567",
      incoming_source: "sso",
      outcome: "flagged",
    });
    expect(other.error).not.toBeNull();
    expect(other.error!.code).toBe("23503");
  });

  test("flagged/ignored conflicts are unique per incoming claim; overwritten may repeat", async () => {
    const judo = await clubId("judo");
    const person = await makePersonOk(judo);
    const row = (outcome: string) => ({
      club_id: judo,
      person_id: person,
      existing_cid: "00000001",
      existing_source: "walk_in",
      incoming_cid: "00000002",
      incoming_source: "purchase",
      outcome,
    });

    const first = await admin.from("person_identity_conflict").insert(row("flagged"));
    expect(first.error).toBeNull();
    const second = await admin.from("person_identity_conflict").insert(row("flagged"));
    expect(second.error).not.toBeNull();
    expect(second.error!.code).toBe("23505");

    // flagged and ignored share one dedup key, so an ignored claim needs a
    // different incoming CID from the flagged one above.
    const ignoredRow = { ...row("ignored"), incoming_cid: "00000003" };
    const ignored = await admin.from("person_identity_conflict").insert(ignoredRow);
    expect(ignored.error).toBeNull();
    const ignoredAgain = await admin.from("person_identity_conflict").insert(ignoredRow);
    expect(ignoredAgain.error!.code).toBe("23505");

    // the same claim cannot be both flagged and ignored
    const clash = await admin.from("person_identity_conflict").insert({ ...row("ignored"), incoming_cid: "00000002" });
    expect(clash.error!.code).toBe("23505");

    const o1 = await admin.from("person_identity_conflict").insert(row("overwritten"));
    const o2 = await admin.from("person_identity_conflict").insert(row("overwritten"));
    expect(o1.error).toBeNull();
    expect(o2.error).toBeNull();
  });

  test("conflict status defaults to resolved and rejects unknown values", async () => {
    const judo = await clubId("judo");
    const person = await makePersonOk(judo);
    const ok = await admin
      .from("person_identity_conflict")
      .insert({ club_id: judo, person_id: person, incoming_cid: "1", incoming_source: "sso", outcome: "overwritten" })
      .select("status")
      .single();
    expect(ok.error).toBeNull();
    expect(ok.data!.status).toBe("resolved");

    const bad = await admin.from("person_identity_conflict").insert({
      club_id: judo,
      person_id: person,
      incoming_cid: "2",
      incoming_source: "sso",
      outcome: "overwritten",
      status: "bogus",
    });
    expect(bad.error!.code).toBe("23514");
  });

  test("person_duplicate_dismissal is unique per (club, name_key, members_hash)", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const key = `test-name-${runId}`;
    const base = { club_id: judo, name_key: key, members_hash: "abc", dismissed_by: "tester" };

    const first = await admin.from("person_duplicate_dismissal").insert(base).select("id").single();
    expect(first.error).toBeNull();
    dismissalIds.push(first.data!.id);

    const dup = await admin.from("person_duplicate_dismissal").insert(base);
    expect(dup.error).not.toBeNull();
    expect(dup.error!.code).toBe("23505");

    const otherClub = await admin
      .from("person_duplicate_dismissal")
      .insert({ ...base, club_id: taekwondo })
      .select("id")
      .single();
    expect(otherClub.error).toBeNull();
    dismissalIds.push(otherClub.data!.id);
  });

  test("the club-scoped client reads and writes both new tables, scoped to its club", async () => {
    const judo = await clubId("judo");
    const taekwondo = await clubId("taekwondo");
    const person = await makePersonOk(judo);
    const scoped = createClubScopedClient(judo);

    const conflict = await scoped
      .from("person_identity_conflict")
      .insert({ person_id: person, incoming_cid: "3", incoming_source: "sso", outcome: "overwritten" })
      .select("id, club_id")
      .single();
    expect(conflict.error).toBeNull();
    expect(conflict.data!.club_id).toBe(judo);

    const dismissal = await scoped
      .from("person_duplicate_dismissal")
      .insert({ name_key: `scoped-${runId}`, members_hash: "h", dismissed_by: "tester" })
      .select("id, club_id")
      .single();
    expect(dismissal.error).toBeNull();
    expect(dismissal.data!.club_id).toBe(judo);
    dismissalIds.push(dismissal.data!.id);

    const own = await scoped.from("person_identity_conflict").select("id").eq("id", conflict.data!.id);
    expect(own.data).toHaveLength(1);

    const otherClub = createClubScopedClient(taekwondo);
    const c = await otherClub.from("person_identity_conflict").select("id").eq("id", conflict.data!.id);
    expect(c.error).toBeNull();
    expect(c.data).toHaveLength(0);
    const d = await otherClub.from("person_duplicate_dismissal").select("id").eq("id", dismissal.data!.id);
    expect(d.error).toBeNull();
    expect(d.data).toHaveLength(0);
  });
});
