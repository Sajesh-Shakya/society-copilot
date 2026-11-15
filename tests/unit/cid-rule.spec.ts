import { test, expect } from "@playwright/test";
import {
  decideCidEvidence,
  outranks,
  CID_SOURCE_RANK,
  type CidSource,
} from "@/lib/identity/cid-rule";

const SOURCES: CidSource[] = ["sso", "purchase", "walk_in"];

test.describe("CID source ranking", () => {
  test("sso > purchase > walk_in", () => {
    expect(CID_SOURCE_RANK).toEqual({ sso: 3, purchase: 2, walk_in: 1 });
    expect(outranks("sso", "purchase")).toBe(true);
    expect(outranks("purchase", "walk_in")).toBe(true);
    expect(outranks("walk_in", "sso")).toBe(false);
    expect(outranks("sso", "sso")).toBe(false);
  });
});

test.describe("decideCidEvidence: different CIDs", () => {
  for (const existing of SOURCES) {
    for (const incoming of SOURCES) {
      const e = CID_SOURCE_RANK[existing];
      const i = CID_SOURCE_RANK[incoming];
      const expected = i > e ? "overwrite" : i === e ? "flag" : "ignore";
      test(`existing ${existing} vs incoming ${incoming} -> ${expected}`, () => {
        expect(
          decideCidEvidence(
            { cid: "11111111", source: existing },
            { cid: "22222222", source: incoming },
          ),
        ).toEqual({ kind: expected });
      });
    }
  }
});

test.describe("decideCidEvidence: null and same CID", () => {
  for (const incoming of SOURCES) {
    test(`null existing CID + ${incoming} -> set`, () => {
      expect(
        decideCidEvidence(
          { cid: null, source: null },
          { cid: "11111111", source: incoming },
        ),
      ).toEqual({ kind: "set" });
    });
  }

  for (const existing of SOURCES) {
    for (const incoming of SOURCES) {
      const higher = CID_SOURCE_RANK[incoming] > CID_SOURCE_RANK[existing];
      test(`same CID existing ${existing} incoming ${incoming} -> confirm`, () => {
        expect(
          decideCidEvidence(
            { cid: "11111111", source: existing },
            { cid: "11111111", source: incoming },
          ),
        ).toEqual({
          kind: "confirm",
          raiseSourceTo: higher ? incoming : null,
        });
      });
    }
  }

  test("existing CID with null source behaves as sso", () => {
    expect(
      decideCidEvidence(
        { cid: "11111111", source: null },
        { cid: "22222222", source: "walk_in" },
      ),
    ).toEqual({ kind: "ignore" });
    expect(
      decideCidEvidence(
        { cid: "11111111", source: null },
        { cid: "22222222", source: "sso" },
      ),
    ).toEqual({ kind: "flag" });
    expect(
      decideCidEvidence(
        { cid: "11111111", source: null },
        { cid: "11111111", source: "sso" },
      ),
    ).toEqual({ kind: "confirm", raiseSourceTo: null });
  });
});

test.describe("decideCidEvidence: holder", () => {
  const holder = { personId: "other-person" };

  test("holder turns set into flag", () => {
    expect(
      decideCidEvidence(
        { cid: null, source: null },
        { cid: "11111111", source: "walk_in" },
        holder,
      ),
    ).toEqual({ kind: "flag", otherPersonId: "other-person" });
  });

  test("holder turns overwrite into flag", () => {
    expect(
      decideCidEvidence(
        { cid: "11111111", source: "walk_in" },
        { cid: "22222222", source: "sso" },
        holder,
      ),
    ).toEqual({ kind: "flag", otherPersonId: "other-person" });
  });

  test("holder leaves ignore unchanged", () => {
    expect(
      decideCidEvidence(
        { cid: "11111111", source: "sso" },
        { cid: "22222222", source: "walk_in" },
        holder,
      ),
    ).toEqual({ kind: "ignore" });
  });

  test("holder leaves confirm unchanged", () => {
    expect(
      decideCidEvidence(
        { cid: "11111111", source: "walk_in" },
        { cid: "11111111", source: "sso" },
        holder,
      ),
    ).toEqual({ kind: "confirm", raiseSourceTo: "sso" });
  });

  test("equal-rank flag without holder has no otherPersonId", () => {
    expect(
      decideCidEvidence(
        { cid: "11111111", source: "purchase" },
        { cid: "22222222", source: "purchase" },
        null,
      ),
    ).toEqual({ kind: "flag" });
  });
});
