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
  member_type: z.string().min(1),
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
 * Stable hash of a raw XLSX row, used as the row's externalId for
 * idempotent ingestion (see lib/purchase/types.ts RawPurchaseRow.externalId
 * and lib/purchase/interface.ts ingestPurchases upsert-on-conflict).
 *
 * Uses JSON.stringify over the row as parsed by `xlsx` (key order matches
 * the sheet's column order, which is stable across re-uploads of the same
 * file), so re-uploading an unchanged file reproduces the same hashes.
 */
export function hashXlsxRow(row: Record<string, unknown>): string {
  const str = JSON.stringify(row);
  return crypto.createHash("sha256").update(str).digest("hex");
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

  for (const row of rows) {
    try {
      const validated = XlsxRowSchema.parse(row);
      const rowHash = hashXlsxRow(row);

      result.push({
        externalId: rowHash,
        personName: validated.name,
        personEmail: validated.email,
        personCid: validated.cid,
        memberType: validated.member_type,
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
