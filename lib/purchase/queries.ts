import { createAdminClient } from "@/lib/supabase/admin";

export interface ProductListItem {
  id: string;
  name: string;
}

/**
 * The curated pass/product catalog, for the admin to pick from before an
 * XLSX upload (see components/purchase/xlsx-uploader.tsx) -- real exports
 * have no product column, so the admin tells the system which pass the
 * whole file is for instead of it being read from a row.
 */
export async function listProducts(): Promise<ProductListItem[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("product").select("id, name").order("name");
  if (error) {
    throw new Error(`Failed to list products: ${error.message}`);
  }
  return data ?? [];
}
