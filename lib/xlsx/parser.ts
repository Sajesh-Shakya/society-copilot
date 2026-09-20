import crypto from "crypto";
import { read, utils } from "xlsx";
import { z } from "zod";
import { RawPurchaseRow } from "@/lib/purchase/types";

const XlsxRowSchema = z.object({
  name: z.string().min(1),
  email: z.email().optional(),
  // Real member-ID columns in Excel are commonly numeric (xlsx auto-types
  // numeric cells as JS `number`), so accept either and coerce to string.
  cid: z
    .union([z.string(), z.number()])
    .transform((val) => String(val))
    .optional(),
  member_type: z.string().optional(),
  product_name: z.string().min(1),
  // A date-typed Excel cell comes back as a native JS Date when the
  // workbook is read with `cellDates: true` (see parseXlsxFile below);
  // someone typing literal ISO text into a cell comes back as a string.
  // Accept either and normalize to an ISO string.
  purchased_at: z.union([z.date(), z.string()]).transform((val, ctx) => {
    const date = typeof val === "string" ? new Date(val) : val;
    if (isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid purchased_at value" });
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
  productName: string;
  purchasedAt: string; // ISO string
  occurrenceIndex: number;
}): string {
  const canonical = JSON.stringify({
    name: input.name,
    email: input.email ?? null,
    cid: input.cid ?? null,
    memberType: input.memberType,
    productName: input.productName,
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
 * Parses an uploaded XLSX file's first sheet into RawPurchaseRow[].
 * Invalid rows (failing XlsxRowSchema) are skipped with a warning rather
 * than aborting the whole upload — a single malformed row shouldn't block
 * everyone else's purchases from being ingested. The number of skipped
 * rows is returned alongside the parsed rows so callers (uploadXlsx) can
 * surface it to the admin instead of it being silently swallowed.
 */
export function parseXlsxFile(buffer: Buffer): ParseXlsxResult {
  // cellDates: true makes date-typed Excel cells come back as native JS
  // Date objects instead of raw numeric serials (e.g. 46023.41666...) —
  // without it, XlsxRowSchema's purchased_at check would reject every
  // real date-typed cell.
  const workbook = read(buffer, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = utils.sheet_to_json(sheet) as Record<string, unknown>[];

  const result: RawPurchaseRow[] = [];
  let skipped = 0;

  // Counts occurrences of each canonical (pre-hash) key so that repeated
  // identical rows within one file get distinct, but re-upload-stable,
  // hashes — see hashXlsxRow's doc comment.
  const occurrenceCounts = new Map<string, number>();

  for (const row of rows) {
    try {
      const validated = XlsxRowSchema.parse(row);
      const memberType = validated.member_type ?? "";

      const canonicalKey = JSON.stringify({
        name: validated.name,
        email: validated.email ?? null,
        cid: validated.cid ?? null,
        memberType,
        productName: validated.product_name,
        purchasedAt: validated.purchased_at,
      });
      const occurrenceIndex = occurrenceCounts.get(canonicalKey) ?? 0;
      occurrenceCounts.set(canonicalKey, occurrenceIndex + 1);

      const rowHash = hashXlsxRow({
        name: validated.name,
        email: validated.email,
        cid: validated.cid,
        memberType,
        productName: validated.product_name,
        purchasedAt: validated.purchased_at,
        occurrenceIndex,
      });

      result.push({
        externalId: rowHash,
        personName: validated.name,
        personEmail: validated.email,
        personCid: validated.cid,
        memberType,
        productName: validated.product_name,
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
