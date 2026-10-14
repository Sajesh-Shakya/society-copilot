import { test, expect } from "@playwright/test";
import { utils, write } from "xlsx";
import { isStudentMemberType } from "@/lib/purchase/types";
import { hashXlsxRow, parseXlsxFile } from "@/lib/xlsx/parser";

// Pure-function tests — no browser, no server, no database. Playwright's
// test runner works fine here since these files just never touch the
// `page` fixture.

const TERM_PASS_ID = "11111111-1111-1111-1111-111111111111";
const ANNUAL_PASS_ID = "22222222-2222-2222-2222-222222222222";

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
    productId: TERM_PASS_ID,
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

  test("differs when the product differs (e.g. a corrected re-upload under a different pass)", () => {
    const original = hashXlsxRow({ ...base, occurrenceIndex: 0 });
    const differentProduct = hashXlsxRow({
      ...base,
      productId: ANNUAL_PASS_ID,
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

  test("parses the real export's header shape (Student ID, Name, Date Purchased, Member Type)", () => {
    const buffer = buildXlsxBuffer([
      {
        "Student ID": "02665790",
        Name: "Winnon Venkatesan",
        "Date Purchased": "14/10/2026 10:55",
        "Member Type": "Student",
      },
    ]);

    const { rows, skipped } = parseXlsxFile(buffer, TERM_PASS_ID);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].personName).toBe("Winnon Venkatesan");
    expect(rows[0].personCid).toBe("02665790");
    expect(rows[0].memberType).toBe("Student");
    expect(rows[0].productId).toBe(TERM_PASS_ID);
    // UK format DD/MM/YYYY -- must not be misread as US MM/DD (14 isn't a
    // valid month, which is exactly how this would surface if it were).
    expect(rows[0].purchasedAt.getUTCFullYear()).toBe(2026);
    expect(rows[0].purchasedAt.getUTCMonth()).toBe(9); // October, 0-indexed
    expect(rows[0].purchasedAt.getUTCDate()).toBe(14);
  });

  test("header matching is case-insensitive and tolerates alternate header names", () => {
    const buffer = buildXlsxBuffer([
      { name: "Grace Hopper", cid: "7654321", "member type": "Staff", "purchase date": "2026-02-01" },
    ]);

    const { rows, skipped } = parseXlsxFile(buffer, TERM_PASS_ID);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].personName).toBe("Grace Hopper");
    expect(rows[0].personCid).toBe("7654321");
    expect(rows[0].memberType).toBe("Staff");
  });

  test("parses a real XLSX buffer with a genuine Date-typed cell", () => {
    // Regression test: a date-typed Excel cell round-trips through
    // sheet_to_json as a native JS Date (with cellDates: true), not a
    // string — getField must convert it, not just pass it through.
    const buffer = buildXlsxBuffer([
      {
        Name: "Ada Lovelace",
        "Student ID": 1234567, // real Excel CID columns are commonly numeric
        "Member Type": "Student",
        "Date Purchased": new Date("2026-01-15T00:00:00.000Z"),
      },
    ]);

    const { rows, skipped } = parseXlsxFile(buffer, TERM_PASS_ID);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].personCid).toBe("1234567");
    expect(rows[0].purchasedAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  test("defaults a blank member_type to a valid row instead of dropping it", () => {
    const buffer = buildXlsxBuffer([{ Name: "Grace Hopper", "Date Purchased": "2026-02-01" }]);

    const { rows, skipped } = parseXlsxFile(buffer, TERM_PASS_ID);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].memberType).toBe("");
  });

  test("skips rows missing a required field (name) and reports the count", () => {
    const buffer = buildXlsxBuffer([
      { Name: "Valid Row", "Date Purchased": "2026-01-01" },
      { "Date Purchased": "2026-01-01" }, // no Name
    ]);

    const { rows, skipped } = parseXlsxFile(buffer, TERM_PASS_ID);

    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  test("skips a row with an unparseable purchase date", () => {
    const buffer = buildXlsxBuffer([{ Name: "Valid Row", "Date Purchased": "not a date" }]);

    const { rows, skipped } = parseXlsxFile(buffer, TERM_PASS_ID);

    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  test("assigns distinct hashes to two identical rows in the same file", () => {
    const identicalRow = { Name: "Ada Lovelace", Email: "ada@example.com", "Date Purchased": "2026-01-15" };
    const buffer = buildXlsxBuffer([identicalRow, identicalRow]);

    const { rows } = parseXlsxFile(buffer, TERM_PASS_ID);

    expect(rows).toHaveLength(2);
    expect(rows[0].externalId).not.toBe(rows[1].externalId);
  });

  test("every row is stamped with the given productId, not read from the file", () => {
    const buffer = buildXlsxBuffer([
      { Name: "Ada Lovelace", "Date Purchased": "2026-01-15", "Product Name": "Something Else" },
    ]);

    const { rows } = parseXlsxFile(buffer, ANNUAL_PASS_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].productId).toBe(ANNUAL_PASS_ID);
  });
});
