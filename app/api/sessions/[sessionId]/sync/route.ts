import { NextResponse } from "next/server";
import { syncSessionAttendance, SessionNotBoundError, SyncDebouncedError } from "@/lib/attendance/sync";
import { EactivitiesApiError, EactivitiesNotConfiguredError } from "@/lib/eactivities/types";

// Manual "sync now" trigger (task 2.2, AC-6). Gated by SYNC_TRIGGER_SECRET,
// not real admin auth — no admin-auth system exists in this app yet (see the
// tracked-gap note in tasks.md, Phase 3). Without SOME gate here, a caller
// could enumerate sessionIds and hit this route directly (no UI required to
// reach it), driving repeated eActivities calls across many sessions at once
// — the per-session 60s debounce inside syncSessionAttendance doesn't stop
// that, since it only rate-limits *one* session, not the route as a whole.
// A flat shared secret closes that off entirely rather than just slowing it
// down. When task 3.0's UI is built, it should call this from a Server
// Action (so the secret stays server-side, never reaches the browser) and
// this gate should be replaced with real per-admin auth at that point.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.SYNC_TRIGGER_SECRET}`;
  if (!process.env.SYNC_TRIGGER_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;

  try {
    const result = await syncSessionAttendance(sessionId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SessionNotBoundError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SyncDebouncedError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof EactivitiesNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (error instanceof EactivitiesApiError) {
      // Surface eActivities' own status (401/403) rather than masking it as
      // a generic 500 — callers (and the debounce UI) need to know this was
      // an upstream auth/rate-limit failure, not a bug in this app.
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
