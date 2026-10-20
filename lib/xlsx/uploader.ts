"use server";

// Gated by requireAdmin() — see lib/auth/require-admin.ts and
// docs/superpowers/specs/2026-09-19-admin-auth-design.md. Every exported
// Server Action here must call it first, matching the pattern used in
// lib/attendance/actions.ts.

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseXlsxFile } from "./parser";
import { ingestPurchases } from "@/lib/purchase/interface";
import { RawPurchaseRow } from "@/lib/purchase/types";

export interface UploadXlsxResult {
  success: boolean;
  message: string;
}

const productIdSchema = z.string().uuid();

export async function uploadXlsx(formData: FormData): Promise<UploadXlsxResult> {
  const adminUser = await requireAdmin();

  const parsedProductId = productIdSchema.safeParse(formData.get("productId"));
  if (!parsedProductId.success) {
    return { success: false, message: "Select which pass/product this file is for." };
  }

  // Real exports have no product/pass-type column at all -- the admin
  // picked one above, and it's trusted here only after confirming it's a
  // real row in `product` (a stale/forged id would otherwise surface as a
  // foreign-key error deep inside ingestPurchases instead of a clear
  // message here).
  const admin = createAdminClient();
  const { data: product, error: productError } = await admin
    .from("product")
    .select("id")
    .eq("id", parsedProductId.data)
    .maybeSingle();
  if (productError) throw productError;
  if (!product) {
    return { success: false, message: "Selected product no longer exists — refresh and try again." };
  }

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
    ({ rows, skipped } = parseXlsxFile(Buffer.from(buffer), product.id));
  } catch (error) {
    console.warn("Failed to parse XLSX file:", error);
    return {
      success: false,
      message: "Could not parse file — is it a valid XLSX file?",
    };
  }

  if (rows.length === 0) {
    return {
      success: false,
      message:
        skipped > 0
          ? `No valid rows found in XLSX — all ${skipped} row(s) failed validation. Check that columns include a name and a purchase date.`
          : "No valid rows found in XLSX — the file appears to be empty.",
    };
  }

  // One purchase_upload row per upload -- lets this batch later be
  // corrected (changeUploadProduct, if the wrong pass was picked above)
  // or undone (undoUpload, if the whole file was wrong) from the
  // "recent uploads" list rather than hand-picking individual rows.
  const { data: upload, error: uploadError } = await admin
    .from("purchase_upload")
    .insert({
      product_id: product.id,
      filename: file.name,
      row_count: rows.length,
      uploaded_by: adminUser.email,
    })
    .select("id")
    .single();
  if (uploadError) throw uploadError;

  const result = await ingestPurchases(rows.map((row) => ({ ...row, uploadId: upload.id })));

  const skippedNote = skipped > 0 ? ` (${skipped} skipped as invalid)` : "";

  return {
    success: true,
    message: `Parsed ${rows.length} rows${skippedNote}. Ingested ${result.inserted} new purchases (${result.duplicates} duplicates, ${result.errors.length} errors)`,
  };
}
