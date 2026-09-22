import Link from "next/link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { listActiveDebtCycles } from "@/lib/chase/debt-cycles";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

export default async function UnpaidPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  // DC-1/DC-5/DC-6, same live view the chase-email generator reads:
  // excludes exempt people, each person's free trial, and anything already
  // waived by a purchase. Sorted worst-first (most unpaid sessions), tied
  // broken by whoever's debt cycle started longest ago.
  const cycles = (await listActiveDebtCycles()).sort((a, b) => {
    if (b.debtCount !== a.debtCount) return b.debtCount - a.debtCount;
    return new Date(a.debtCycleStartedAt).getTime() - new Date(b.debtCycleStartedAt).getTime();
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Unpaid sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everyone currently in debt, worst first. Excludes exempt members and each
            person&apos;s free trial session.
          </p>
        </div>
        <Link href="/sessions" className="text-sm text-muted-foreground underline">
          Back to sessions
        </Link>
      </div>

      {cycles.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">Nobody currently owes anything.</p>
      ) : (
        <div className="mt-8 flex flex-col gap-2">
          {cycles.map((cycle) => (
            <div
              key={cycle.personId}
              className="flex items-center justify-between gap-4 rounded-lg border p-4"
            >
              <div>
                <p className="font-medium">{cycle.fullName}</p>
                <p className="text-xs text-muted-foreground">{cycle.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  owing since {new Date(cycle.debtCycleStartedAt).toLocaleDateString()} (
                  {daysAgo(cycle.debtCycleStartedAt)}d ago)
                </span>
                <Badge variant={cycle.debtCount >= 3 ? "destructive" : "secondary"}>
                  {cycle.debtCount} unpaid {cycle.debtCount === 1 ? "session" : "sessions"}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
