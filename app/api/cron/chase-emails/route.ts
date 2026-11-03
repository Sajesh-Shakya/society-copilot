import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateChaseEmails } from "@/lib/chase/generator";
import { processAutoSends } from "@/lib/chase/send";
import { reapplyWaiversForEveryoneWithDebt } from "@/lib/purchase/interface";

// Weekly Vercel Cron target (see vercel.json). Vercel Hobby cron's once/day
// floor is fine here -- see design.md's Scheduling decision, which already
// carves out the weekly chase-email run as a Vercel Cron use case (unlike
// the per-session eActivities sync, which needs pg_cron instead).
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: clubs, error: clubsError } = await admin.from("club").select("id, slug");
  if (clubsError) {
    return NextResponse.json({ error: `Failed to list clubs: ${clubsError.message}` }, { status: 500 });
  }

  const results: {
    clubSlug: string;
    reapplied?: Awaited<ReturnType<typeof reapplyWaiversForEveryoneWithDebt>>;
    generated?: Awaited<ReturnType<typeof generateChaseEmails>>;
    sent?: Awaited<ReturnType<typeof processAutoSends>>;
    error?: string;
  }[] = [];

  for (const club of clubs ?? []) {
    try {
      // Safety-net sweep, not the primary fix (see
      // reapplyWaiversForEveryoneWithDebt's doc comment) -- runs first so
      // anything it catches is resolved before generateChaseEmails can turn
      // it into an undeserved chase email.
      const reapplied = await reapplyWaiversForEveryoneWithDebt(club.id);
      const generated = await generateChaseEmails(club.id);
      const sent = await processAutoSends(club.id);
      results.push({ clubSlug: club.slug, reapplied, generated, sent });
    } catch (error) {
      // One club's failure (e.g. a bad row, a transient Resend outage)
      // must never block the rest -- same reasoning as ingestPurchases's
      // per-row try/catch.
      console.error(`Chase-email cron failed for club "${club.slug}":`, error);
      results.push({ clubSlug: club.slug, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return NextResponse.json({ results });
}
