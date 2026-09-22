import { NextResponse } from "next/server";
import { syncSessionAttendance, SessionNotBoundError, SyncDebouncedError } from "@/lib/attendance/sync";
import { EactivitiesApiError, EactivitiesNotConfiguredError } from "@/lib/eactivities/types";

// Scheduled trigger target (task 2.3, AC-7). Called by the
// eactivities-sync-dispatcher Edge Function via pg_cron — NOT by Vercel
// Cron (see design.md's Scheduling decision: Vercel Hobby cron can't do
// sub-daily, session-specific triggers). Auth is CRON_SECRET, not an admin
// session, since this is machine-to-machine.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { sessionId } = (await request.json()) as { sessionId?: string };
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const result = await syncSessionAttendance(sessionId);
    return NextResponse.json(result);
  } catch (error) {
    // SessionNotBoundError / SyncDebouncedError are benign here — the
    // dispatcher just tries again next cron tick regardless — so 200 keeps
    // them out of error monitoring. EactivitiesApiError passes through
    // eActivities' real status (401/403) so an upstream auth/rate-limit
    // problem is actually visible; EactivitiesNotConfiguredError is a real
    // misconfiguration worth surfacing as a 500.
    if (error instanceof SessionNotBoundError || error instanceof SyncDebouncedError) {
      return NextResponse.json({ error: error.message }, { status: 200 });
    }
    if (error instanceof EactivitiesNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (error instanceof EactivitiesApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
