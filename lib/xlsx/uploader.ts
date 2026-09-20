"use server";

// Gated by requireAdmin() — see lib/auth/require-admin.ts and
// docs/superpowers/specs/2026-09-19-admin-auth-design.md. Every exported
// Server Action here must call it first, matching the pattern used in
// lib/attendance/actions.ts.

import { requireAdmin } from "@/lib/auth/require-admin";
import { parseXlsxFile } from "./parser";
import { ingestPurchases } from "@/lib/purchase/interface";
import { RawPurchaseRow } from "@/lib/purchase/types";

export interface UploadXlsxResult {
  success: boolean;
  message: string;
}

export async function uploadXlsx(formData: FormData): Promise<UploadXlsxResult> {
  await requireAdmin();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, message: "No file provided" };
  }

  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { success: false, message: "File must be .xlsx format" };
  }

  const buffer = await file.arrayBuffer();

  let rows: RawPurchaseRow[];
  let skipped: number;
  try {
    ({ rows, skipped } = parseXlsxFile(Buffer.from(buffer)));
  } catch (error) {
    console.warn("Failed to parse XLSX file:", error);
    return {
      success: false,
      message: "Could not parse file — is it a valid XLSX file?",
    };
  }

  if (rows.length === 0) {
    return { success: false, message: "No valid rows found in XLSX" };
  }

  const result = await ingestPurchases(rows);

  const skippedNote = skipped > 0 ? ` (${skipped} skipped as invalid)` : "";

  return {
    success: true,
    message: `Parsed ${rows.length} rows${skippedNote}. Ingested ${result.inserted} new purchases (${result.duplicates} duplicates, ${result.errors.length} errors)`,
  };
}
