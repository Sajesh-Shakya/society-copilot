import { PendingLink } from '@/components/nav/pending-link';
import { requireAdmin, UnauthorizedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';
import { createClubScopedClient } from '@/lib/supabase/club-scoped';
import { XlsxUploader } from '@/components/purchase/xlsx-uploader';
import { PurchasesTable, type PurchaseRow } from '@/components/purchase/purchases-table';
import { RecentUploads } from '@/components/purchase/recent-uploads';
import { listProducts } from '@/lib/purchase/queries';
import { listRecentUploads } from '@/lib/purchase/interface';
import { clubPath } from '@/lib/club-path';

export const dynamic = 'force-dynamic';
// Server Actions used on this page (uploadXlsx) inherit this limit. 300 s is
// the project's Default Max Duration in Vercel (confirmed by the user). A
// first-time upload of ~5,000 matched rows measured ~120 s on dev, so this
// leaves ~2.5x headroom; roughly 12,000 matched rows is the extrapolated ceiling.
export const maxDuration = 300;

export default async function AdminPurchasesPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  let clubId: string;
  try {
    ({ clubId } = await requireAdmin(clubSlug));
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect('/login');
    throw error;
  }

  const scoped = createClubScopedClient(clubId);
  const purchaseColumns =
    'id, raw_person_name, raw_cid, raw_email, source, purchased_at, match_status, product:product_id(name), person:person_id(full_name)';
  // The latest 20 purchases, plus every unmatched one (capped) so older
  // unmatched rows can still be matched by hand from this table.
  const [{ data: rawRecent }, { data: rawUnmatched }, products, recentUploads] = await Promise.all([
    scoped.from('purchase').select(purchaseColumns).order('purchased_at', { ascending: false }).limit(20),
    scoped
      .from('purchase')
      .select(purchaseColumns)
      .eq('match_status', 'unmatched')
      .order('purchased_at', { ascending: false })
      .limit(200),
    listProducts(clubId),
    listRecentUploads(clubId, 5),
  ]);

  type RawPurchase = { id: string; purchased_at: string };
  const byId = new Map<string, RawPurchase>();
  for (const rows of [rawRecent, rawUnmatched]) {
    for (const row of (rows ?? []) as unknown as RawPurchase[]) byId.set(row.id, row);
  }
  const rawPurchases = [...byId.values()].sort((a, b) => b.purchased_at.localeCompare(a.purchased_at));

  const purchaseRows = rawPurchases as unknown as {
    id: string;
    raw_person_name: string;
    raw_cid: string | null;
    raw_email: string | null;
    source: string;
    purchased_at: string;
    match_status: string;
    product: { name: string } | { name: string }[] | null;
    person: { full_name: string } | { full_name: string }[] | null;
  }[];

  const purchases: PurchaseRow[] = purchaseRows.map((p) => {
    // supabase-js types a to-one FK select as an array; each is always
    // exactly one row (or none, for an unmatched purchase's null
    // person_id) since both are not-null FKs when present.
    const product = Array.isArray(p.product) ? p.product[0] : p.product;
    const person = Array.isArray(p.person) ? p.person[0] : p.person;
    return {
      id: p.id,
      rawPersonName: p.raw_person_name,
      rawCid: p.raw_cid,
      rawEmail: p.raw_email,
      productName: product?.name ?? null,
      matchStatus: p.match_status,
      matchedPersonName: person?.full_name ?? null,
      source: p.source,
      purchasedAt: p.purchased_at,
    };
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-10">
      <PendingLink href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
        ← All sessions
      </PendingLink>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Purchase Management</h1>

      <div className="mt-8 rounded-lg border p-4">
        <h2 className="font-semibold">Upload XLSX</h2>
        <p className="text-sm text-muted-foreground">
          Pick which pass this file is for, then upload it — the export has no
          product column of its own, so every row in the file is recorded as a
          purchase of the pass you select. Expected columns: Name, Student ID
          (or Email), Member Type, Date Purchased.
        </p>
        <div className="mt-4">
          <XlsxUploader clubSlug={clubSlug} products={products} />
        </div>
        <div className="mt-6">
          <RecentUploads clubSlug={clubSlug} uploads={recentUploads} products={products} />
        </div>
      </div>

      <div className="mt-8">
        <h2 className="font-semibold">Recent Purchases ({purchases.length})</h2>
        {purchases.length > 0 ? (
          <div className="mt-4">
            <PurchasesTable clubSlug={clubSlug} purchases={purchases} />
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No purchases yet.</p>
        )}
      </div>
    </div>
  );
}
