import { test, expect } from "@playwright/test";
import {
  buildPersonIndex,
  fetchAllPages,
  matchAgainstIndex,
} from "@/lib/purchase/person-index";
import type { RawPurchaseRow } from "@/lib/purchase/types";

function row(over: Partial<RawPurchaseRow>): RawPurchaseRow {
  return {
    externalId: "x",
    personName: "",
    memberType: "Public",
    purchasedAt: new Date("2026-01-01"),
    source: "xlsx_upload",
    ...over,
  };
}

const people = [
  { id: "p1", cid: "02665790", email: "Ann@X.com", full_name: "Ann Lee" },
  { id: "p2", cid: null, email: "j.smith@x.com", full_name: "John Smith" },
  { id: "p3", cid: null, email: null, full_name: "Sam Twin" },
  { id: "p4", cid: null, email: null, full_name: "sam twin" },
];

test.describe("matchAgainstIndex", () => {
  const index = buildPersonIndex(people);

  test("CID match", () => {
    expect(matchAgainstIndex(row({ personCid: "02665790" }), index)).toEqual({
      personId: "p1",
      matchStatus: "cid_matched",
    });
  });

  test("CID with lost leading zero still matches", () => {
    expect(matchAgainstIndex(row({ personCid: "2665790" }), index)).toEqual({
      personId: "p1",
      matchStatus: "cid_matched",
    });
  });

  test("student with unmatched CID is unmatched even if email/name match", () => {
    const r = row({
      memberType: "Student",
      personCid: "99999999",
      personEmail: "ann@x.com",
      personName: "Ann Lee",
    });
    expect(matchAgainstIndex(r, index)).toEqual({ matchStatus: "unmatched" });
  });

  test("non-student falls back to case-insensitive email", () => {
    const r = row({ personCid: "99999999", personEmail: "ANN@x.com" });
    expect(matchAgainstIndex(r, index)).toEqual({
      personId: "p1",
      matchStatus: "email_matched",
    });
  });

  test("underscore in email is literal, not a wildcard", () => {
    const r = row({ personEmail: "j_smith@x.com" });
    expect(matchAgainstIndex(r, index)).toEqual({ matchStatus: "unmatched" });
  });

  test("unique name matches ignoring case/whitespace", () => {
    expect(matchAgainstIndex(row({ personName: "  JOHN smith " }), index)).toEqual({
      personId: "p2",
      matchStatus: "name_matched",
    });
  });

  test("ambiguous name is unmatched", () => {
    expect(matchAgainstIndex(row({ personName: "Sam Twin" }), index)).toEqual({
      matchStatus: "unmatched",
    });
  });
});

test.describe("fetchAllPages", () => {
  test("pages until a short page", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => i);
    let calls = 0;
    const out = await fetchAllPages(async (from, to) => {
      calls++;
      return all.slice(from, to + 1);
    }, 1000);
    expect(out).toHaveLength(2500);
    expect(calls).toBe(3);
  });
});
