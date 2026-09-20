import { requireAdmin, UnauthorizedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { XlsxUploader } from '@/components/purchase/xlsx-uploader';

export const dynamic = 'force-dynamic';

export default async function AdminPurchasesPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect('/login');
    throw error;
  }

  const admin = createAdminClient();
  const { data: purchases } = await admin
    .from('purchase')
    .select('id, person_id, product_id, source, purchased_at, match_status')
    .order('purchased_at', { ascending: false })
    .limit(20);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Purchase Management</h1>

      <div className="mt-8 rounded-lg border p-4">
        <h2 className="font-semibold">Upload XLSX</h2>
        <p className="text-sm text-muted-foreground">
          Upload an XLSX file with columns: name, email, cid, member_type, product_name, purchased_at
        </p>
        <div className="mt-4">
          <XlsxUploader />
        </div>
      </div>

      <div className="mt-8">
        <h2 className="font-semibold">Recent Purchases ({purchases?.length || 0})</h2>
        {purchases && purchases.length > 0 ? (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2">Source</th>
                <th className="text-left py-2">Status</th>
                <th className="text-left py-2">Purchased</th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id} className="border-b">
                  <td className="py-2">{p.source}</td>
                  <td className="py-2">{p.match_status}</td>
                  <td className="py-2">{new Date(p.purchased_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No purchases yet.</p>
        )}
      </div>
    </div>
  );
}
