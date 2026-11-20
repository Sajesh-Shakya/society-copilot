import { redirect } from "next/navigation";
import { PendingLink } from "@/components/nav/pending-link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { listProductsWithPrices } from "@/lib/products/queries";
import { ProductManager } from "@/components/products/product-manager";
import { clubPath } from "@/lib/club-path";

export const dynamic = "force-dynamic";

export default async function AdminProductsPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;
  let clubId: string;
  try {
    ({ clubId } = await requireAdmin(clubSlug));
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const products = await listProductsWithPrices(clubId);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-10">
      <PendingLink href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
        ← All sessions
      </PendingLink>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Products &amp; prices</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Prices are copied onto each purchase when it is uploaded, so changing a price never changes past revenue.
      </p>
      <div className="mt-6">
        <ProductManager clubSlug={clubSlug} products={products} />
      </div>
    </div>
  );
}
