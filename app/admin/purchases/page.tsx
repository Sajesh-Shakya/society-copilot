import Link from 'next/link';
import { requireAdmin, UnauthorizedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { XlsxUploader } from '@/components/purchase/xlsx-uploader';
import { PurchasesTable, type PurchaseRow } from '@/components/purchase/purchases-table';
import { RecentUploads } from '@/components/purchase/recent-uploads';
import { listProducts } from '@/lib/purchase/queries';
import { listRecentUploads } from '@/lib/purchase/interface';

export const dynamic = 'force-dynamic';

export default async function AdminPurchasesPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect('/login');
    throw error;
  }

  const admin = createAdminClient();
  const [{ data: rawPurchases }, products, recentUploads] = await Promise.all([
    admin
      .from('purchase')
      .select(
        'id, raw_person_name, raw_cid, raw_email, source, purchased_at, match_status, product:product_id(name), person:person_id(full_name)'
      )
      .order('purchased_at', { ascending: false })
      .limit(20),
    listProducts(),
    listRecentUploads(5),
  ]);

  const purchases: PurchaseRow[] = (rawPurchases ?? []).map((p) => {
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
      <Link href="/sessions" className="text-sm text-muted-foreground underline">
        ← All sessions
      </Link>
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
          <XlsxUploader products={products} />
        </div>
        <div className="mt-6">
          <RecentUploads uploads={recentUploads} products={products} />
        </div>
      </div>

      <div className="mt-8">
        <h2 className="font-semibold">Recent Purchases ({purchases.length})</h2>
        {purchases.length > 0 ? (
          <div className="mt-4">
            <PurchasesTable purchases={purchases} />
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No purchases yet.</p>
        )}
      </div>
    </div>
  );
}
