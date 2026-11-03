import { createClubScopedClient } from "@/lib/supabase/club-scoped";

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
export async function listProducts(clubId: string): Promise<ProductListItem[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped.from("product").select("id, name").order("name");
  if (error) {
    throw new Error(`Failed to list products: ${error.message}`);
  }
  // createClubScopedClient's select() loses type inference under tsc --
  // same workaround as lib/attendance/sync.ts, interface.ts, and this
  // file's own callers.
  return (data as unknown as ProductListItem[] | null) ?? [];
}
