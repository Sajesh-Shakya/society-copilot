import crypto from "crypto";
import { read, utils } from "xlsx";
import { z } from "zod";
import { RawPurchaseRow } from "@/lib/purchase/types";

// Case-insensitive, whitespace-tolerant header lookup -- mirrors
// lib/csv-import/parser.ts's getField. xlsx's sheet_to_json() keys each
// row object by the literal header text found in the file, and the real
// export this reads has headers like "Student ID", "Name", "Date
// Purchased", "Member Type" -- nothing like this module's previous exact
// lowercase/snake_case keys ever matched them. `aliases` lets one logical
// field accept whichever header name a given export actually uses.
function getField(row: Record<string, unknown>, aliases: string[]): string | undefined {
  const targets = aliases.map((a) => a.toLowerCase());
  const key = Object.keys(row).find((k) => targets.includes(k.trim().toLowerCase()));
  if (key === undefined) return undefined;
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

// Real "Date Purchased" cells observed so far look like "14/10/2026
// 10:55" (DD/MM/YYYY HH:mm, UK format) when the column is stored as text
// rather than an Excel date type. new Date(...) on a slash-separated
// string assumes US MM/DD/YYYY and silently misparses or returns Invalid
// Date for any day-of-month above 12 (e.g. "14/10/2026" has no month 14)
// -- so this is parsed explicitly rather than handed to the Date
// constructor. A genuine Excel date-typed cell never reaches this
// function: parseXlsxFile's getField already converts those to an ISO
// string via `cellDates: true` before this runs, and that ISO string
// parses correctly below without matching this regex.
function parseDateField(value: string): Date | null {
  const ukMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (ukMatch) {
    const [, day, month, year, hour, minute] = ukMatch;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0)
    );
    return isNaN(date.getTime()) ? null : date;
  }
  const generic = new Date(value);
  return isNaN(generic.getTime()) ? null : generic;
}

const XlsxRowSchema = z.object({
  name: z.string().min(1),
  email: z.email().optional(),
  cid: z.string().optional(),
  member_type: z.string().optional(),
  purchased_at: z.string().transform((val, ctx) => {
    const date = parseDateField(val);
    if (!date) {
      ctx.addIssue({ code: "custom", message: `Invalid purchased_at value "${val}"` });
      return z.NEVER;
    }
    return date.toISOString();
  }),
});

/**
 * Stable hash of a row's canonical (schema-mapped) fields, used as the
 * row's externalId for idempotent ingestion. Hashing only the fields this
 * pipeline actually reads — not the whole raw sheet row — means volatile or
 * extraneous spreadsheet columns (a running total, an "exported at" column)
 * don't change the hash across re-exports of overlapping data.
 *
 * `productId` is part of the hash: the same buyer/date pair ingested under
 * two different admin-selected products (e.g. a correction re-upload) must
 * hash differently, not collide as a false duplicate.
 *
 * `occurrenceIndex` disambiguates genuinely distinct purchases that happen
 * to share every mapped field (same person, product, and date) — without
 * it they would hash identically and the second would be wrongly treated
 * as a duplicate of the first.
 */
export function hashXlsxRow(input: {
  name: string;
  email?: string;
  cid?: string;
  memberType: string;
  productId: string;
  purchasedAt: string; // ISO string
  occurrenceIndex: number;
}): string {
  const canonical = JSON.stringify({
    name: input.name,
    email: input.email ?? null,
    cid: input.cid ?? null,
    memberType: input.memberType,
    productId: input.productId,
    purchasedAt: input.purchasedAt,
    occurrenceIndex: input.occurrenceIndex,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export interface ParseXlsxResult {
  rows: RawPurchaseRow[];
  skipped: number;
}

/**
 * Parses an uploaded XLSX file's first sheet into RawPurchaseRow[], all
 * stamped with the given productId -- real exports have no product/pass-
 * type column at all, so the admin picks one product for the whole file
 * before uploading (see components/purchase/xlsx-uploader.tsx) rather
 * than it being read from a column.
 *
 * Invalid rows (missing name/purchased_at, or an unparseable date) are
 * skipped with a warning rather than aborting the whole upload — a single
 * malformed row shouldn't block everyone else's purchases from being
 * ingested. The number of skipped rows is returned alongside the parsed
 * rows so callers (uploadXlsx) can surface it to the admin instead of it
 * being silently swallowed.
 */
export function parseXlsxFile(buffer: Buffer, productId: string): ParseXlsxResult {
  // cellDates: true makes date-typed Excel cells come back as native JS
  // Date objects instead of raw numeric serials (e.g. 46023.41666...).
  // raw: true keeps every other cell's original value (in particular,
  // text-stored numeric IDs like a Student ID "02665790" keep their
  // leading zero instead of being reformatted/renumbered).
  const workbook = read(buffer, { cellDates: true, raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = utils.sheet_to_json(sheet) as Record<string, unknown>[];

  const result: RawPurchaseRow[] = [];
  let skipped = 0;

  // Counts occurrences of each canonical (pre-hash) key so that repeated
  // identical rows within one file get distinct, but re-upload-stable,
  // hashes — see hashXlsxRow's doc comment.
  const occurrenceCounts = new Map<string, number>();

  for (const row of rows) {
    const rawName = getField(row, ["name", "full name", "student name"]);
    const rawEmail = getField(row, ["email"]);
    const rawCid = getField(row, ["cid", "student id", "card number", "card no"]);
    const rawMemberType = getField(row, ["member type", "membertype"]);
    const rawPurchasedAt = getField(row, ["purchased_at", "date purchased", "purchase date", "date"]);

    try {
      const validated = XlsxRowSchema.parse({
        name: rawName,
        email: rawEmail,
        cid: rawCid,
        member_type: rawMemberType,
        purchased_at: rawPurchasedAt,
      });
      const memberType = validated.member_type ?? "";

      const canonicalKey = JSON.stringify({
        name: validated.name,
        email: validated.email ?? null,
        cid: validated.cid ?? null,
        memberType,
        productId,
        purchasedAt: validated.purchased_at,
      });
      const occurrenceIndex = occurrenceCounts.get(canonicalKey) ?? 0;
      occurrenceCounts.set(canonicalKey, occurrenceIndex + 1);

      const rowHash = hashXlsxRow({
        name: validated.name,
        email: validated.email,
        cid: validated.cid,
        memberType,
        productId,
        purchasedAt: validated.purchased_at,
        occurrenceIndex,
      });

      result.push({
        externalId: rowHash,
        personName: validated.name,
        personEmail: validated.email,
        personCid: validated.cid,
        memberType,
        productId,
        purchasedAt: new Date(validated.purchased_at),
        source: "xlsx_upload" as const,
      });
    } catch (error) {
      skipped += 1;
      console.warn("Skipping invalid XLSX row:", error);
    }
  }

  return { rows: result, skipped };
}
