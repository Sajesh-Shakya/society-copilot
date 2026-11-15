import { test, expect } from "@playwright/test";
import {
  walkInSchema,
  validateWalkInFields,
  firstWalkInError,
  CID_ERROR,
  NAME_ERROR,
  EMAIL_ERROR,
} from "@/lib/identity/walk-in-schema";

const base = {
  sessionId: "7b0c1f2e-3d4a-4b5c-8d6e-9f0a1b2c3d4e",
  email: "sean@example.com",
  fullName: "Sean Rawlins",
};

test.describe("walkInSchema cid", () => {
  test("normalises a 7-digit CID", () => {
    const r = walkInSchema.parse({ ...base, cid: "6113211" });
    expect(r.cid).toBe("06113211");
  });

  test("accepts trimmed 8-digit CIDs", () => {
    expect(walkInSchema.parse({ ...base, cid: " 06113211 " }).cid).toBe("06113211");
    expect(walkInSchema.parse({ ...base, cid: "03079021" }).cid).toBe("03079021");
  });

  for (const bad of ["123456", "123456789", "0611 3211", "0307902x"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      const r = walkInSchema.safeParse({ ...base, cid: bad });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe(CID_ERROR);
    });
  }

  test("empty or missing cid is ok", () => {
    expect(walkInSchema.safeParse({ ...base, cid: "" }).success).toBe(true);
    expect(walkInSchema.safeParse({ ...base, cid: "   " }).success).toBe(true);
    expect(walkInSchema.safeParse({ ...base }).success).toBe(true);
    expect(walkInSchema.safeParse({ ...base, cid: undefined }).success).toBe(true);
  });

  test("error text is exact", () => {
    expect(CID_ERROR).toBe("CID is 8 digits, or 7 if you leave off the leading 0");
  });
});

test.describe("walkInSchema fullName", () => {
  test("rejects a single word", () => {
    const r = walkInSchema.safeParse({ ...base, fullName: "Sean" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe(NAME_ERROR);
  });

  test("collapses whitespace", () => {
    expect(walkInSchema.parse({ ...base, fullName: "  Sean   Rawlins " }).fullName).toBe(
      "Sean Rawlins",
    );
  });

  test("rejects words without letters", () => {
    const r = walkInSchema.safeParse({ ...base, fullName: "1 2" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe(NAME_ERROR);
  });

  test("error text is exact", () => {
    expect(NAME_ERROR).toBe("Enter first name and surname");
  });
});

test.describe("walkInSchema other fields", () => {
  test("rejects an invalid email", () => {
    expect(walkInSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });

  test("rejects a non-uuid sessionId", () => {
    expect(walkInSchema.safeParse({ ...base, sessionId: "x" }).success).toBe(false);
  });
});

test.describe("validateWalkInFields", () => {
  test("returns no errors for valid fields", () => {
    expect(
      validateWalkInFields({ email: "sean@example.com", fullName: "Sean Rawlins", cid: "6113211" }),
    ).toEqual({});
  });

  test("empty cid is fine", () => {
    expect(
      validateWalkInFields({ email: "sean@example.com", fullName: "Sean Rawlins", cid: "" }),
    ).toEqual({});
  });

  test("returns the shared messages per field", () => {
    expect(validateWalkInFields({ email: "nope", fullName: "Sean", cid: "12345" })).toEqual({
      email: EMAIL_ERROR,
      fullName: NAME_ERROR,
      cid: CID_ERROR,
    });
  });
});

test.describe("firstWalkInError", () => {
  test("gives the first issue's message", () => {
    const r = walkInSchema.safeParse({ ...base, fullName: "Sean" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstWalkInError(r.error)).toBe(NAME_ERROR);
  });
});
