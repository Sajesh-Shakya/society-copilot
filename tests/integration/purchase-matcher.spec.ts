import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { matchPersonRecord } from "@/lib/purchase/matcher";
import type { RawPurchaseRow } from "@/lib/purchase/types";

const admin = createAdminClient();

function row(overrides: Partial<RawPurchaseRow> = {}): RawPurchaseRow {
  return {
    externalId: `matcher-test-${randomUUID()}`,
    personName: "Matcher Test Person",
    memberType: "Public",
    productName: "Test Product",
    purchasedAt: new Date("2026-02-01T00:00:00.000Z"),
    source: "xlsx_upload",
    ...overrides,
  };
}

test.describe("matchPersonRecord", () => {
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length > 0) {
      await admin.from("person").delete().in("id", personIds);
      personIds = [];
    }
  });

  async function createPerson(fields: { cid?: string; email?: string; fullName: string }): Promise<string> {
    const { data, error } = await admin
      .from("person")
      .insert({ full_name: fields.fullName, email: fields.email ?? `matcher-${randomUUID()}@example.test`, cid: fields.cid ?? null })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create test person: ${error?.message}`);
    personIds.push(data.id);
    return data.id;
  }

  test("matches on CID even when the row's CID lost its leading zero (numeric Excel cell)", async () => {
    // A random 7-digit CID (not a real/realistic value) -- avoids any
    // collision with real data that's been through the person.cid
    // backfill, which would otherwise make this test's exact-match
    // lookup ambiguous (2+ rows) instead of a clean single match.
    const cid7 = String(Math.floor(1_000_000 + Math.random() * 8_000_000));
    const cid8 = `0${cid7}`;
    const personId = await createPerson({ cid: cid8, fullName: "Matcher Test CID Person" });

    // Simulates a Student ID column stored as a true Excel number, which
    // this test's caller (lib/xlsx/parser.ts) would normally have already
    // normalized before this function ever sees it -- matchPersonRecord
    // normalizes again anyway, as defense-in-depth for any other caller.
    const result = await matchPersonRecord(
      row({ personCid: cid7, memberType: "Student", personName: "Matcher Test CID Person" })
    );

    expect(result).toEqual({ personId, matchStatus: "cid_matched" });
  });

  test("a CID-bearing student whose CID matches nothing stays unmatched, even with a matching name", async () => {
    const sharedName = `Matcher Test Nomatch ${randomUUID()}`;
    await createPerson({ fullName: sharedName }); // no CID recorded at all

    const result = await matchPersonRecord(
      row({ personCid: "99999999", memberType: "Student", personName: sharedName })
    );

    // Rule 2's "no fallback for CID-bearing students" -- a wrong auto-match
    // here would misattribute a real payment, so this must stay unmatched
    // for manual review rather than falling back to the name.
    expect(result).toEqual({ matchStatus: "unmatched" });
  });

  test("matches on name when neither CID nor email is available (real export has no email column)", async () => {
    const personId = await createPerson({ fullName: `Unique Name ${randomUUID()}` });
    const { data: person } = await admin.from("person").select("full_name").eq("id", personId).single();

    const result = await matchPersonRecord(row({ personName: person!.full_name, memberType: "Public" }));

    expect(result).toEqual({ personId, matchStatus: "name_matched" });
  });

  test("an ambiguous name (two people share it) is left unmatched, not guessed", async () => {
    const sharedName = `Shared Name ${randomUUID()}`;
    await createPerson({ fullName: sharedName });
    await createPerson({ fullName: sharedName });

    const result = await matchPersonRecord(row({ personName: sharedName, memberType: "Public" }));

    expect(result).toEqual({ matchStatus: "unmatched" });
  });

  test("matches on email when CID is absent and the name alone would be ambiguous", async () => {
    const sharedName = `Shared Email Test ${randomUUID()}`;
    await createPerson({ fullName: sharedName });
    const email = `matcher-specific-${randomUUID()}@example.test`;
    const personId = await createPerson({ fullName: sharedName, email });

    const result = await matchPersonRecord(row({ personName: sharedName, personEmail: email, memberType: "Public" }));

    expect(result).toEqual({ personId, matchStatus: "email_matched" });
  });
});
