import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { productInputSchema, productPatchSchema, type ProductInput, type ProductPatch } from "./schema";

// Plain module (not "use server"): authorization lives in the requireAdmin
// wrappers in lib/products/actions.ts. Validation failures are returned,
// never thrown.

const DUPLICATE_NAME = "A product with that name already exists.";
const DUPLICATE_SALES_ID = "Another product already uses that sales ID.";

function dbError(error: { code?: string; message: string; details?: string | null }): { error: string } {
  if (error.code === "23505") {
    return { error: (error.details ?? error.message).includes("external_sales_id") || error.message.includes("external_sales_id") ? DUPLICATE_SALES_ID : DUPLICATE_NAME };
  }
  return { error: error.message };
}

export async function createProduct(clubId: string, input: ProductInput): Promise<{ id: string } | { error: string }> {
  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const v = parsed.data;
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("product")
    .insert({
      name: v.name,
      kind: v.kind,
      covers_sessions: v.coversSessions,
      price_pence: v.pricePence,
      external_sales_id: v.externalSalesId,
    })
    .select("id")
    .single();
  if (error) return dbError(error);
  return { id: (data as unknown as { id: string }).id };
}

// Never touches existing purchases: their price_pence is a snapshot.
export async function updateProduct(
  clubId: string,
  id: string,
  patch: ProductPatch
): Promise<{ ok: true } | { error: string }> {
  const parsed = productPatchSchema.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const v = parsed.data;
  const update: Record<string, unknown> = {};
  if (v.name !== undefined) update.name = v.name;
  if (v.pricePence !== undefined) update.price_pence = v.pricePence;
  if (v.active !== undefined) update.active = v.active;
  if (v.externalSalesId !== undefined) update.external_sales_id = v.externalSalesId;
  if (Object.keys(update).length === 0) return { ok: true };

  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped.from("product").update(update).eq("id", id).select("id");
  if (error) return dbError(error);
  if (!data || data.length === 0) return { error: "Product not found." };
  return { ok: true };
}

export async function applyPriceToUnpricedPurchases(
  clubId: string,
  productId: string
): Promise<{ updated: number } | { error: string }> {
  const scoped = createClubScopedClient(clubId);
  const { data: product, error: productError } = await scoped
    .from("product")
    .select("price_pence")
    .eq("id", productId)
    .maybeSingle();
  if (productError) return { error: productError.message };
  const price = (product as unknown as { price_pence: number | null } | null)?.price_pence;
  if (!product) return { error: "Product not found." };
  if (price === null || price === undefined) return { error: "Set a price on this product first." };

  const { data, error } = await scoped
    .from("purchase")
    .update({ price_pence: price })
    .eq("product_id", productId)
    .is("price_pence", null)
    .select("id");
  if (error) return { error: error.message };
  return { updated: data?.length ?? 0 };
}
