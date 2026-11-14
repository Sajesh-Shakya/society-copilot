import { findExistingSourceRowIds } from "@/lib/purchase/existing";
import type { RawPurchaseRow } from "@/lib/purchase/types";

/**
 * Splits parsed XLSX rows into ones not yet ingested and a count of those
 * already present, so an upload batch is only created for genuinely new
 * rows. Kept out of uploader.ts because that file is "use server" and
 * would expose every export as a callable Server Action.
 * Throws if the lookup fails -- never treat a failed lookup as "all new".
 */
export async function planXlsxUpload(
  rows: RawPurchaseRow[],
  clubId: string
): Promise<{ newRows: RawPurchaseRow[]; alreadyIngested: number }> {
  const existing = await findExistingSourceRowIds(
    clubId,
    "xlsx_upload",
    rows.map((r) => r.externalId)
  );
  const newRows = rows.filter((r) => !existing.has(r.externalId));
  return { newRows, alreadyIngested: rows.length - newRows.length };
}
