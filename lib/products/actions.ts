"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { createProduct, updateProduct, applyPriceToUnpricedPurchases } from "@/lib/products/writer";
import type { ProductInput, ProductPatch } from "@/lib/products/schema";

// Thin admin-gated wrappers; logic lives in lib/products/writer.ts.

export async function createProductAction(clubSlug: string, input: ProductInput) {
  const admin = await requireAdmin(clubSlug);
  return createProduct(admin.clubId, input);
}

export async function updateProductAction(clubSlug: string, id: string, patch: ProductPatch) {
  const admin = await requireAdmin(clubSlug);
  return updateProduct(admin.clubId, id, patch);
}

export async function applyPriceAction(clubSlug: string, id: string) {
  const admin = await requireAdmin(clubSlug);
  return applyPriceToUnpricedPurchases(admin.clubId, id);
}
