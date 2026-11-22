import { createClubScopedClient } from "@/lib/supabase/club-scoped";

export interface ProductRow {
  id: string;
  name: string;
  kind: string;
  coversSessions: number | null;
  pricePence: number | null;
  active: boolean;
  externalSalesId: string | null;
  purchaseCount: number;
  unpricedPurchaseCount: number;
}

type DbProduct = {
  id: string;
  name: string;
  kind: string;
  covers_sessions: number | null;
  price_pence: number | null;
  active: boolean;
  external_sales_id: string | null;
};

// Counts use head-count queries so the 1000-row PostgREST cap never truncates them.
export async function listProductsWithPrices(clubId: string): Promise<ProductRow[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("product")
    .select("id, name, kind, covers_sessions, price_pence, active, external_sales_id")
    .order("name");
  if (error) throw new Error(`listProductsWithPrices: ${error.message}`);
  const products = (data ?? []) as unknown as DbProduct[];

  return Promise.all(
    products.map(async (p) => {
      const [total, unpriced] = await Promise.all([
        scoped.from("purchase").select("id", { count: "exact", head: true }).eq("product_id", p.id),
        scoped.from("purchase").select("id", { count: "exact", head: true }).eq("product_id", p.id).is("price_pence", null),
      ]);
      if (total.error) throw new Error(`listProductsWithPrices: ${total.error.message}`);
      if (unpriced.error) throw new Error(`listProductsWithPrices: ${unpriced.error.message}`);
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        coversSessions: p.covers_sessions,
        pricePence: p.price_pence,
        active: p.active,
        externalSalesId: p.external_sales_id,
        purchaseCount: total.count ?? 0,
        unpricedPurchaseCount: unpriced.count ?? 0,
      };
    })
  );
}
