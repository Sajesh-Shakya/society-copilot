import { NextResponse } from "next/server";
import { generateChaseEmails } from "@/lib/chase/generator";
import { processAutoSends } from "@/lib/chase/send";

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

  const generated = await generateChaseEmails();
  const sent = await processAutoSends();

  return NextResponse.json({ generated, sent });
}
