import Link from 'next/link';
import { requireAdmin, UnauthorizedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { XlsxUploader } from '@/components/purchase/xlsx-uploader';
import { listProducts } from '@/lib/purchase/queries';

export const dynamic = 'force-dynamic';

export default async function AdminPurchasesPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect('/login');
    throw error;
  }

  const admin = createAdminClient();
  const [{ data: purchases }, products] = await Promise.all([
    admin
      .from('purchase')
      .select('id, person_id, product_id, source, purchased_at, match_status')
      .order('purchased_at', { ascending: false })
      .limit(20),
    listProducts(),
  ]);

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
      </div>

      <div className="mt-8">
        <h2 className="font-semibold">Recent Purchases ({purchases?.length || 0})</h2>
        {purchases && purchases.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="whitespace-nowrap text-left py-2">Source</th>
                  <th className="whitespace-nowrap text-left py-2">Status</th>
                  <th className="whitespace-nowrap text-left py-2">Purchased</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((p) => (
                  <tr key={p.id} className="border-b">
                    <td className="whitespace-nowrap py-2">{p.source}</td>
                    <td className="whitespace-nowrap py-2">{p.match_status}</td>
                    <td className="whitespace-nowrap py-2">{new Date(p.purchased_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No purchases yet.</p>
        )}
      </div>
    </div>
  );
}
