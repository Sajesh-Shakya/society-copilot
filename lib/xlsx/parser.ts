import crypto from "crypto";
import { read, utils } from "xlsx";
import { z } from "zod";
import { RawPurchaseRow } from "@/lib/purchase/types";

const XlsxRowSchema = z.object({
  name: z.string().min(1),
  email: z.email().optional(),
  cid: z.string().optional(),
  member_type: z.string().min(1),
  product_name: z.string().min(1),
  purchased_at: z.iso.datetime(),
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

/**
 * Parses an uploaded XLSX file's first sheet into RawPurchaseRow[].
 * Invalid rows (failing XlsxRowSchema) are skipped with a warning rather
 * than aborting the whole upload — a single malformed row shouldn't block
 * everyone else's purchases from being ingested.
 */
export function parseXlsxFile(buffer: Buffer): RawPurchaseRow[] {
  const workbook = read(buffer);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = utils.sheet_to_json(sheet) as Record<string, unknown>[];

  const result: RawPurchaseRow[] = [];

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
      console.warn("Skipping invalid XLSX row:", error);
    }
  }

  return result;
}
