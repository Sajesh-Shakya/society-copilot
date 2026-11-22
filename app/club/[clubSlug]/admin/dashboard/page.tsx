import { redirect } from "next/navigation";
import { PendingLink } from "@/components/nav/pending-link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { getDashboard } from "@/lib/dashboard/queries";
import { formatPounds, formatSessionLabel, owedRange, signupBand } from "@/lib/dashboard/format";
import { TargetsForm } from "@/components/dashboard/targets-form";
import { clubPath } from "@/lib/club-path";

export const dynamic = "force-dynamic";

const WEEK_OPTIONS = [4, 8, 12, 26];
const BAND_CLASS = {
  green: "text-green-600",
  amber: "text-amber-600",
  red: "text-red-600",
  none: "text-muted-foreground",
} as const;

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ clubSlug: string }>;
  searchParams: Promise<{ weeks?: string | string[] }>;
}) {
  const { clubSlug } = await params;
  const { weeks: weeksParam } = await searchParams;
  let clubId: string;
  try {
    ({ clubId } = await requireAdmin(clubSlug));
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const requested = Number(Array.isArray(weeksParam) ? weeksParam[0] : weeksParam);
  const weeks = WEEK_OPTIONS.includes(requested) ? requested : 8;
  const end = new Date();
  const start = new Date(end.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);

  const d = await getDashboard(clubId, { start, end });
  const { signupTarget, signupMin } = d.targets;
  const band = signupBand(d.averageSignups, signupTarget, signupMin);
  const range = owedRange(d.owed.sessions, d.singleSessionPrices);
  const chartRows = [...d.signups].reverse(); // oldest first, every session in the range
  const maxBar = Math.max(signupTarget, ...d.signups.map((s) => s.signups), 1);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <PendingLink href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
        ← All sessions
      </PendingLink>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="flex gap-2 text-sm">
          {WEEK_OPTIONS.map((w) => (
            <PendingLink
              key={w}
              href={clubPath(clubSlug, `/admin/dashboard?weeks=${w}`)}
              className={w === weeks ? "font-semibold underline" : "text-muted-foreground underline"}
            >
              {w}w
            </PendingLink>
          ))}
        </div>
      </div>

      <section className="mt-6 rounded-lg border p-4">
        <h2 className="font-semibold">Signups per session</h2>
        <p className={`mt-2 text-3xl font-semibold ${BAND_CLASS[band]}`}>
          {d.averageSignups === null ? "–" : d.averageSignups.toFixed(1)}
        </p>
        <p className="text-sm text-muted-foreground">
          average over the last {weeks} weeks · target {signupTarget} / minimum {signupMin}
          {d.averageAttended !== null && ` · ${d.averageAttended.toFixed(1)} attended on average`}
        </p>
        {d.signups.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No sessions in this range.</p>
        ) : (
          <ul className="mt-4 max-h-96 space-y-1 overflow-y-auto">
            {chartRows.map((s) => (
              <li key={s.sessionId} className="flex items-center gap-3 text-xs" title={s.title}>
                <span className="w-32 shrink-0 text-muted-foreground">{formatSessionLabel(s.startsAt)}</span>
                <div className="relative h-4 flex-1 rounded bg-muted">
                  <div className="h-4 rounded bg-primary" style={{ width: `${(s.signups / maxBar) * 100}%` }} />
                  <div className="absolute inset-y-0 w-px bg-foreground" style={{ left: `${(signupTarget / maxBar) * 100}%` }} />
                </div>
                <span className="w-8 text-right">{s.signups}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <TargetsForm clubSlug={clubSlug} signupTarget={signupTarget} signupMin={signupMin} />
        </div>
      </section>

      <section className="mt-6 rounded-lg border p-4">
        <h2 className="font-semibold">Revenue</h2>
        <p className="mt-2 text-3xl font-semibold">{formatPounds(d.totalRevenuePence)}</p>
        {d.unpricedPurchases > 0 && (
          <p className="text-sm text-muted-foreground">
            {d.unpricedPurchases} purchases have no price —{" "}
            <PendingLink href={clubPath(clubSlug, "/admin/products")} className="underline">set prices</PendingLink>
          </p>
        )}
        {d.revenue.length > 0 && (
          <table className="mt-3 w-full text-sm">
            <tbody>
              {d.revenue.map((r) => (
                <tr key={r.productId} className="border-t">
                  <td className="py-1">{r.productName}</td>
                  <td className="py-1 text-right text-muted-foreground">{r.purchases} sold</td>
                  <td className="py-1 text-right">{formatPounds(r.revenuePence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-6 rounded-lg border p-4">
        <h2 className="font-semibold">Money owed</h2>
        <p className="mt-2 text-sm">
          {d.owed.sessions} unpaid sessions across {d.owed.people} people
          {range && `, worth ${formatPounds(range.lowPence)} to ${formatPounds(range.highPence)}`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          By age of oldest unpaid session: 0–14 days {d.owed.buckets.d0_14} · 15–30 days {d.owed.buckets.d15_30} · 31+ days {d.owed.buckets.d31plus} people
        </p>
      </section>
    </div>
  );
}
