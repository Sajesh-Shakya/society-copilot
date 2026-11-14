import { test, expect } from "@playwright/test";
import { utils, write } from "xlsx";
import { parseXlsxFile } from "@/lib/xlsx/parser";

// Regression pin: re-uploading an export that gained one more identical
// row must only produce ONE new externalId, so already-ingested rows can be
// skipped by hash lookup (see lib/purchase/existing.ts).

const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";

function buildBuffer(rows: Record<string, string>[]): Buffer {
  const sheet = utils.json_to_sheet(rows);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sheet1");
  return write(workbook, { type: "buffer", bookType: "xlsx" });
}

const same = {
  "Student ID": "02665790",
  Name: "Winnon Venkatesan",
  "Date Purchased": "14/10/2026 10:55",
  "Member Type": "Student",
};
const other = {
  "Student ID": "01234567",
  Name: "Ada Lovelace",
  "Date Purchased": "15/10/2026 09:00",
  "Member Type": "Student",
};

test("appending a 4th identical row leaves the first three externalIds unchanged", () => {
  const first = parseXlsxFile(buildBuffer([same, same, same, other]), PRODUCT_ID).rows;
  const second = parseXlsxFile(buildBuffer([same, same, same, same, other]), PRODUCT_ID).rows;

  expect(first).toHaveLength(4);
  expect(second).toHaveLength(5);

  const firstIds = new Set(first.map((r) => r.externalId));
  expect(firstIds.size).toBe(4); // occurrence index keeps identical rows distinct

  const newIds = second.map((r) => r.externalId).filter((id) => !firstIds.has(id));
  expect(newIds).toHaveLength(1);
  expect(second.slice(0, 3).map((r) => r.externalId)).toEqual(first.slice(0, 3).map((r) => r.externalId));
  expect(second[3].externalId).not.toBe(second[2].externalId);
  expect(second[4].externalId).toBe(first[3].externalId);
});
