import { test, expect } from "@playwright/test";
import { utils, write } from "xlsx";
import { isStudentMemberType } from "@/lib/purchase/types";
import { hashXlsxRow, parseXlsxFile } from "@/lib/xlsx/parser";

// Pure-function tests — no browser, no server, no database. Playwright's
// test runner works fine here since these files just never touch the
// `page` fixture.

test.describe("isStudentMemberType", () => {
  test("matches 'Student' exactly", () => {
    expect(isStudentMemberType("Student")).toBe(true);
  });

  test("matches case-insensitively (real spreadsheets vary in casing)", () => {
    expect(isStudentMemberType("STUDENT")).toBe(true);
    expect(isStudentMemberType("student")).toBe(true);
    expect(isStudentMemberType("  Student  ")).toBe(true);
  });

  test("defaults every other value to false, including blank", () => {
    expect(isStudentMemberType("Public")).toBe(false);
    expect(isStudentMemberType("Associate")).toBe(false);
    expect(isStudentMemberType("Staff")).toBe(false);
    expect(isStudentMemberType("")).toBe(false);
  });
});

test.describe("hashXlsxRow", () => {
  const base = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    cid: "01234567",
    memberType: "Student",
    productName: "Term Pass",
    purchasedAt: "2026-01-15T00:00:00.000Z",
  };

  test("is stable for identical canonical input (re-uploading the same file)", () => {
    const h1 = hashXlsxRow({ ...base, occurrenceIndex: 0 });
    const h2 = hashXlsxRow({ ...base, occurrenceIndex: 0 });
    expect(h1).toBe(h2);
  });

  test("differs by occurrenceIndex, so two genuinely distinct same-day purchases don't collide", () => {
    const first = hashXlsxRow({ ...base, occurrenceIndex: 0 });
    const second = hashXlsxRow({ ...base, occurrenceIndex: 1 });
    expect(first).not.toBe(second);
  });

  test("differs when any canonical field differs", () => {
    const original = hashXlsxRow({ ...base, occurrenceIndex: 0 });
    const differentProduct = hashXlsxRow({
      ...base,
      productName: "Annual Pass",
      occurrenceIndex: 0,
    });
    expect(original).not.toBe(differentProduct);
  });
});

test.describe("parseXlsxFile", () => {
  function buildXlsxBuffer(rows: Record<string, unknown>[]): Buffer {
    const sheet = utils.json_to_sheet(rows);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Sheet1");
    return write(workbook, { type: "buffer", bookType: "xlsx" });
  }

  test("parses a real XLSX buffer with a genuine Date-typed cell", () => {
    // Regression test for the bug fixed in the purchase-ingestion plan's
    // Task 4 fix round: a date-typed Excel cell round-trips through
    // sheet_to_json as a native JS Date (with cellDates: true), not an ISO
    // string — the schema must accept both.
    const buffer = buildXlsxBuffer([
      {
        name: "Ada Lovelace",
        email: "ada@example.com",
        cid: 1234567, // real Excel CID columns are commonly numeric
        member_type: "Student",
        product_name: "Term Pass",
        purchased_at: new Date("2026-01-15T00:00:00.000Z"),
      },
    ]);

    const { rows, skipped } = parseXlsxFile(buffer);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].personCid).toBe("1234567");
    expect(rows[0].memberType).toBe("Student");
    expect(rows[0].purchasedAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  test("defaults a blank member_type to a valid row instead of dropping it", () => {
    const buffer = buildXlsxBuffer([
      {
        name: "Grace Hopper",
        product_name: "Session Pass",
        purchased_at: "2026-02-01",
      },
    ]);

    const { rows, skipped } = parseXlsxFile(buffer);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].memberType).toBe("");
  });

  test("skips rows missing a required field and reports the count", () => {
    const buffer = buildXlsxBuffer([
      { name: "Valid Row", product_name: "Term Pass", purchased_at: "2026-01-01" },
      { name: "Missing product", purchased_at: "2026-01-01" }, // no product_name
    ]);

    const { rows, skipped } = parseXlsxFile(buffer);

    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  test("assigns distinct hashes to two identical rows in the same file", () => {
    const identicalRow = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      product_name: "Term Pass",
      purchased_at: "2026-01-15",
    };
    const buffer = buildXlsxBuffer([identicalRow, identicalRow]);

    const { rows } = parseXlsxFile(buffer);

    expect(rows).toHaveLength(2);
    expect(rows[0].externalId).not.toBe(rows[1].externalId);
  });
});
