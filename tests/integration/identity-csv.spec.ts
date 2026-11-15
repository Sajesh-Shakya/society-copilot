import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { importAttendanceCsv, resolvePeopleForRows } from "@/lib/csv-import/importer";
import { applyCidEvidenceBatch } from "@/lib/identity/apply-cid-evidence";
import type { CidSource } from "@/lib/identity/cid-rule";
import type { AttendeeRow } from "@/lib/csv-import/parser";

const admin = createAdminClient();

let judo: string;
test.beforeAll(async () => {
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  judo = data.id;
});

test.describe("CSV import applies the CID trust rule", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];
  const runId = Date.now().toString(36);
  let n = 0;

  test.afterEach(async () => {
    if (sessionIds.length) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
    }
    if (personIds.length) {
      for (let i = 0; i < personIds.length; i += 100) {
        const ids = personIds.slice(i, i + 100);
        await admin.from("person_identity_conflict").delete().in("person_id", ids);
        await admin.from("person_identity_conflict").delete().in("other_person_id", ids);
      }
      for (let i = 0; i < personIds.length; i += 100) {
        await admin.from("person").delete().in("id", personIds.slice(i, i + 100));
      }
    }
    personIds = [];
    sessionIds = [];
  });

  /** A CID unique to this run, so it never collides with real members. */
  function testCid(tag: string) {
    return `T${runId}${tag}`;
  }

  function newEmail() {
    n += 1;
    return `identity-csv-${runId}-${n}@example.test`;
  }

  async function makePerson(cid: string | null, cidSource: CidSource | null, fullName = "Identity Csv Test") {
    const email = newEmail();
    const { data, error } = await admin
      .from("person")
      .insert({ club_id: judo, full_name: fullName, email, cid, cid_source: cidSource })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(data.id);
    return { id: data.id as string, email };
  }

  function row(email: string, cid: string | null): AttendeeRow {
    return { firstName: "Identity", surname: "Csv Test", email, rawCidOrCardNumber: cid };
  }

  async function resolve(rows: AttendeeRow[]) {
    const ids = await resolvePeopleForRows(judo, rows);
    for (const id of ids) if (!personIds.includes(id)) personIds.push(id);
    return ids;
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

  async function holdersOf(cid: string) {
    const { data, error } = await admin.from("person").select("id").eq("club_id", judo).eq("cid", cid);
    if (error) throw error;
    return (data ?? []).map((r) => r.id as string);
  }

  test("Ayaan: an sso CSV CID replaces a walk-in CID, logging one overwritten conflict", async () => {
    const walkInCid = testCid("03079021");
    const ssoCid = testCid("06113211");
    const ayaan = await makePerson(walkInCid, "walk_in", "Ayaan Test");

    const result = await importAttendanceCsv(
      { title: "Identity CSV Ayaan Test", startsAt: "2026-11-15T18:00:00.000Z", rows: [row(ayaan.email, ssoCid)] },
      judo,
    );
    sessionIds.push(result.sessionId);

    const { data: record } = await admin
      .from("attendance_record")
      .select("person_id")
      .eq("session_id", result.sessionId)
      .single();
    expect(record!.person_id).toBe(ayaan.id);
    expect(await person(ayaan.id)).toEqual({ cid: ssoCid, cid_source: "sso" });
    const rows = await conflicts(ayaan.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      existing_cid: walkInCid,
      existing_source: "walk_in",
      incoming_cid: ssoCid,
      incoming_source: "sso",
      outcome: "overwritten",
      status: "resolved",
      other_person_id: null,
    });
  });

  test("an sso person given a different sso CID is flagged open and left unchanged", async () => {
    const kept = testCid("k1");
    const p = await makePerson(kept, "sso");

    const ids = await resolve([row(p.email, testCid("k2"))]);

    expect(ids).toEqual([p.id]);
    expect(await person(p.id)).toEqual({ cid: kept, cid_source: "sso" });
    const rows = await conflicts(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "flagged",
      status: "open",
      existing_cid: kept,
      existing_source: "sso",
      incoming_cid: testCid("k2"),
      incoming_source: "sso",
      other_person_id: null,
    });
  });

  test("a CID held by one person on a row whose email matches another flags the email owner", async () => {
    const held = testCid("h1");
    const holder = await makePerson(held, "sso");
    const emailOwner = await makePerson(null, null);

    const ids = await resolve([row(emailOwner.email, held)]);

    // CID-first matching is unchanged: the row is the CID holder's.
    expect(ids).toEqual([holder.id]);
    expect(await person(holder.id)).toEqual({ cid: held, cid_source: "sso" });
    expect(await person(emailOwner.id)).toEqual({ cid: null, cid_source: null });
    expect(await conflicts(holder.id)).toHaveLength(0);
    const rows = await conflicts(emailOwner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "flagged",
      status: "open",
      existing_cid: null,
      incoming_cid: held,
      incoming_source: "sso",
      other_person_id: holder.id,
    });
  });

  test("a swap file (A has B's CID, B has A's) completes, flags both, and leaves no duplicate CIDs", async () => {
    const x = testCid("sx");
    const y = testCid("sy");
    const a = await makePerson(x, "walk_in");
    const b = await makePerson(y, "walk_in");

    const ids = await resolve([row(a.email, y), row(b.email, x)]);

    // Each row's CID belongs to the other person, so CID-first resolves it there.
    expect(ids).toEqual([b.id, a.id]);
    expect(await person(a.id)).toEqual({ cid: x, cid_source: "walk_in" });
    expect(await person(b.id)).toEqual({ cid: y, cid_source: "walk_in" });
    expect(await holdersOf(x)).toEqual([a.id]);
    expect(await holdersOf(y)).toEqual([b.id]);
    const aRows = await conflicts(a.id);
    const bRows = await conflicts(b.id);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0]).toMatchObject({ outcome: "flagged", status: "open", incoming_cid: y, other_person_id: b.id });
    expect(bRows[0]).toMatchObject({ outcome: "flagged", status: "open", incoming_cid: x, other_person_id: a.id });
  });

  test("an overwrite frees the old CID for a later row's existing person in the same file", async () => {
    const x = testCid("vx");
    const z = testCid("vz");
    const a = await makePerson(x, "walk_in");
    const c = await makePerson(null, null);

    const ids = await resolve([row(a.email, z), row(c.email, x)]);

    expect(ids).toEqual([a.id, c.id]);
    expect(await person(a.id)).toEqual({ cid: z, cid_source: "sso" });
    expect(await person(c.id)).toEqual({ cid: x, cid_source: "sso" });
    expect(await conflicts(a.id)).toMatchObject([{ outcome: "overwritten", existing_cid: x, incoming_cid: z }]);
    expect(await conflicts(c.id)).toHaveLength(0);
  });

  test("an overwrite frees the old CID for a new person later in the same file", async () => {
    const x = testCid("nx");
    const z = testCid("nz");
    const a = await makePerson(x, "walk_in");

    const ids = await resolve([row(a.email, z), row(newEmail(), x)]);

    expect(ids[0]).toBe(a.id);
    expect(ids[1]).not.toBe(a.id);
    expect(await person(a.id)).toEqual({ cid: z, cid_source: "sso" });
    expect(await person(ids[1])).toEqual({ cid: x, cid_source: "sso" });
  });

  test("new people get cid_source sso when the row has a CID, null otherwise", async () => {
    const cid = testCid("new");
    const ids = await resolve([row(newEmail(), cid), row(newEmail(), null)]);
    expect(await person(ids[0])).toEqual({ cid, cid_source: "sso" });
    expect(await person(ids[1])).toEqual({ cid: null, cid_source: null });
  });

  test("importing the same file twice adds no new conflict rows", async () => {
    const flagged = await makePerson(testCid("r1"), "sso");
    const overwritten = await makePerson(testCid("r2"), "walk_in");
    const a = await makePerson(testCid("rx"), "walk_in");
    const b = await makePerson(testCid("ry"), "walk_in");
    const file = [
      row(flagged.email, testCid("r1b")),
      row(overwritten.email, testCid("r2b")),
      row(a.email, testCid("ry")),
      row(b.email, testCid("rx")),
    ];
    const all = [flagged.id, overwritten.id, a.id, b.id];
    const count = async () => {
      const { data, error } = await admin.from("person_identity_conflict").select("id, outcome").in("person_id", all);
      if (error) throw error;
      return data!;
    };

    await resolve(file);
    const first = await count();
    expect(first.filter((r) => r.outcome === "flagged")).toHaveLength(3);
    expect(first.filter((r) => r.outcome === "overwritten")).toHaveLength(1);

    await resolve(file);
    const second = await count();
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
  });

  test("read queries stay constant in row count; one update per changed person", async () => {
    async function countRequests(size: number, tag: string) {
      const people = [];
      for (let i = 0; i < size; i++) people.push(await makePerson(testCid(`${tag}w${i}`), "walk_in"));
      const rows = people.map((p, i) => row(p.email, testCid(`${tag}s${i}`)));
      const counts = { GET: 0, PATCH: 0, POST: 0 };
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase() as keyof typeof counts;
        if (method in counts) counts[method] += 1;
        return realFetch(input, init);
      }) as typeof fetch;
      const started = Date.now();
      try {
        await resolve(rows);
      } finally {
        globalThis.fetch = realFetch;
      }
      console.log(`[identity-csv] ${size} overwrite rows: ${JSON.stringify(counts)} in ${Date.now() - started} ms`);
      for (const [i, p] of people.entries()) {
        if (i % 10 === 0) expect(await person(p.id)).toEqual({ cid: testCid(`${tag}s${i}`), cid_source: "sso" });
      }
      return counts;
    }

    const small = await countRequests(5, "q");
    const large = await countRequests(60, "Q");
    expect(large.GET).toBe(small.GET);
    expect(small.PATCH).toBe(5);
    expect(large.PATCH).toBe(60);
    expect(large.POST).toBe(small.POST);
  });
});

test.describe("applyCidEvidenceBatch", () => {
  let personIds: string[] = [];
  const runId = `b${Date.now().toString(36)}`;
  let n = 0;

  test.afterEach(async () => {
    if (personIds.length) {
      await admin.from("person_identity_conflict").delete().in("person_id", personIds);
      await admin.from("person_identity_conflict").delete().in("other_person_id", personIds);
      await admin.from("person").delete().in("id", personIds);
    }
    personIds = [];
  });

  function testCid(tag: string) {
    return `T${runId}${tag}`;
  }

  async function makePerson(cid: string | null, cidSource: CidSource | null) {
    n += 1;
    const { data, error } = await admin
      .from("person")
      .insert({
        club_id: judo,
        full_name: "Identity Batch Test",
        email: `identity-batch-${runId}-${n}@example.test`,
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
    const { data, error } = await admin.from("person_identity_conflict").select("*").eq("person_id", personId);
    if (error) throw error;
    return data as Array<Record<string, unknown>>;
  }

  test("applies a vacating overwrite before a claim even when the claim is listed first", async () => {
    const x = testCid("x");
    const z = testCid("z");
    const a = await makePerson(x, "walk_in");
    const c = await makePerson(null, null);

    await applyCidEvidenceBatch(createClubScopedClient(judo), [
      { personId: c, cid: x, source: "sso", decision: { kind: "set" }, existing: { cid: null, source: null } },
      { personId: a, cid: z, source: "sso", decision: { kind: "overwrite" }, existing: { cid: x, source: "walk_in" } },
    ]);

    expect(await person(a)).toEqual({ cid: z, cid_source: "sso" });
    expect(await person(c)).toEqual({ cid: x, cid_source: "sso" });
    expect(await conflicts(a)).toMatchObject([{ outcome: "overwritten", existing_cid: x, incoming_cid: z }]);
  });

  test("a residual unique violation downgrades that one row to a flag without aborting", async () => {
    const held = testCid("h");
    const holder = await makePerson(held, "sso");
    const p = await makePerson(null, null);
    const q = await makePerson(null, null);

    await applyCidEvidenceBatch(createClubScopedClient(judo), [
      // Stale plan: thinks nobody holds `held`.
      { personId: p, cid: held, source: "sso", decision: { kind: "set" }, existing: { cid: null, source: null } },
      { personId: q, cid: testCid("q"), source: "sso", decision: { kind: "set" }, existing: { cid: null, source: null } },
    ]);

    expect(await person(p)).toEqual({ cid: null, cid_source: null });
    expect(await person(q)).toEqual({ cid: testCid("q"), cid_source: "sso" });
    expect(await person(holder)).toEqual({ cid: held, cid_source: "sso" });
    expect(await conflicts(p)).toMatchObject([
      { outcome: "flagged", status: "open", incoming_cid: held, other_person_id: holder },
    ]);
  });

  test("a guarded write that misses because the person changed is downgraded to a flag", async () => {
    const p = await makePerson(testCid("now"), "sso");

    await applyCidEvidenceBatch(createClubScopedClient(judo), [
      { personId: p, cid: testCid("new"), source: "sso", decision: { kind: "overwrite" }, existing: { cid: testCid("old"), source: "walk_in" } },
    ]);

    expect(await person(p)).toEqual({ cid: testCid("now"), cid_source: "sso" });
    expect(await conflicts(p)).toMatchObject([{ outcome: "flagged", status: "open", incoming_cid: testCid("new") }]);
  });

  test("dedups against existing rows: promotes an ignored row, keeps a dismissed flag, drops in-batch repeats", async () => {
    const p = await makePerson(testCid("p"), "sso");
    const r = await makePerson(testCid("r"), "sso");
    const { data: seeded, error } = await admin
      .from("person_identity_conflict")
      .insert([
        { club_id: judo, person_id: p, existing_cid: testCid("p"), existing_source: "sso", incoming_cid: testCid("i"), incoming_source: "sso", outcome: "ignored", status: "resolved" },
        { club_id: judo, person_id: r, existing_cid: testCid("r"), existing_source: "sso", incoming_cid: testCid("d"), incoming_source: "sso", outcome: "flagged", status: "dismissed", resolved_by: "tester" },
      ])
      .select("id, person_id");
    if (error) throw error;
    const flag = { kind: "flag" } as const;

    await applyCidEvidenceBatch(createClubScopedClient(judo), [
      { personId: p, cid: testCid("i"), source: "sso", decision: flag, existing: { cid: testCid("p"), source: "sso" } },
      { personId: r, cid: testCid("d"), source: "sso", decision: flag, existing: { cid: testCid("r"), source: "sso" } },
      { personId: r, cid: testCid("e"), source: "sso", decision: { kind: "ignore" }, existing: { cid: testCid("r"), source: "sso" } },
      { personId: r, cid: testCid("e"), source: "sso", decision: flag, existing: { cid: testCid("r"), source: "sso" } },
      { personId: r, cid: testCid("e"), source: "sso", decision: flag, existing: { cid: testCid("r"), source: "sso" } },
    ]);

    const pRows = await conflicts(p);
    expect(pRows).toHaveLength(1);
    expect(pRows[0]).toMatchObject({
      id: seeded!.find((s) => s.person_id === p)!.id,
      outcome: "flagged",
      status: "open",
      resolved_by: null,
    });
    const rRows = await conflicts(r);
    expect(rRows).toHaveLength(2);
    expect(rRows.find((x) => x.incoming_cid === testCid("d"))).toMatchObject({ status: "dismissed", resolved_by: "tester" });
    expect(rRows.find((x) => x.incoming_cid === testCid("e"))).toMatchObject({ outcome: "flagged", status: "open" });
  });
});
