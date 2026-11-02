import { createClubScopedClient } from "@/lib/supabase/club-scoped";

// Caller identity is checked in app/club/[clubSlug]/sessions/[sessionId]/page.tsx
// (the only caller) before this runs — see lib/auth/require-admin.ts.

export interface AttendanceRow {
  attendanceRecordId: string;
  personId: string;
  fullName: string;
  email: string;
  attended: boolean;
  source: "signup_sync" | "manual_tick" | "walk_in" | "csv_import";
}

export interface SessionWithAttendance {
  id: string;
  title: string;
  startsAt: string;
  eactivitiesSignupId: string | null;
  lastSyncedAt: string | null;
  cancelledAt: string | null;
  attendance: AttendanceRow[];
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was not found for this club.`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Closes the toggle_attendance/by-id IDOR gap: that RPC (and several
 * Server Actions below it) take only a sessionId, with no club argument
 * of their own (Plan 2b-1 deliberately kept them row-scoped). Every
 * caller that accepts a sessionId from the client must call this first.
 */
export async function assertSessionBelongsToClub(sessionId: string, clubId: string): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped.from("session").select("id").eq("id", sessionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new SessionNotFoundError(sessionId);
}

/**
 * Server-only read (admin client — person/session are deny-all RLS). Used by
 * app/club/[clubSlug]/sessions/[sessionId]/page.tsx as the initial render; the client then
 * layers Realtime updates on top (see components/attendance/attendance-screen.tsx).
 */
export async function getSessionWithAttendance(
  sessionId: string,
  clubId: string
): Promise<SessionWithAttendance | null> {
  const scoped = createClubScopedClient(clubId);

  const { data: session, error: sessionError } = await scoped
    .from("session")
    .select("id, title, starts_at, eactivities_signup_id, last_synced_at, cancelled_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return null;
  // createClubScopedClient's select() wrapper types `columns` as a plain
  // `string` rather than a literal, so supabase-js can't statically parse
  // the query -- same cast-after-fetch convention as lib/attendance/sync.ts.
  const typedSession = session as unknown as {
    id: string;
    title: string;
    starts_at: string;
    eactivities_signup_id: string | null;
    last_synced_at: string | null;
    cancelled_at: string | null;
  };

  const { data: records, error: recordsError } = await scoped
    .from("attendance_record")
    .select("id, attended, source, person:person_id(id, full_name, email)")
    .eq("session_id", sessionId);
  if (recordsError) throw recordsError;
  const typedRecords = records as unknown as {
    id: string;
    attended: boolean;
    source: AttendanceRow["source"];
    person: { id: string; full_name: string; email: string } | { id: string; full_name: string; email: string }[];
  }[];

  const attendance: AttendanceRow[] = (typedRecords ?? [])
    .map((record) => {
      // supabase-js types a to-one FK select as an array; it's always
      // exactly one row here since person_id is not-null with a FK.
      const person = Array.isArray(record.person) ? record.person[0] : record.person;
      return {
        attendanceRecordId: record.id,
        personId: person.id,
        fullName: person.full_name,
        email: person.email,
        attended: record.attended,
        source: record.source,
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  return {
    id: typedSession.id,
    title: typedSession.title,
    startsAt: typedSession.starts_at,
    eactivitiesSignupId: typedSession.eactivities_signup_id,
    lastSyncedAt: typedSession.last_synced_at,
    cancelledAt: typedSession.cancelled_at,
    attendance,
  };
}

export interface SessionListItem {
  id: string;
  title: string;
  startsAt: string;
  attendeeCount: number;
  isToday: boolean;
  isFuture: boolean;
  cancelledAt: string | null;
}

function isUtcToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

/**
 * AC-9: sessions from the last 30 days, plus any future-dated session (a
 * session can be created ahead of its start time), newest-starting first.
 * Server-only read (admin client) -- caller checks admin identity first,
 * same convention as getSessionWithAttendance above.
 *
 * A cancelled session keeps showing (struck through, "Cancelled" badge)
 * for a 30-minute grace period after cancellation -- long enough for the
 * admin who just cancelled it to see the change took effect, or un-cancel
 * it if it was a mistake -- then drops off this list entirely. The
 * session row and its attendance aren't deleted (see setSessionCancelled
 * in lib/attendance/actions.ts) and the direct /club/[clubSlug]/sessions/[id]
 * link still works indefinitely; only this dashboard listing hides it.
 */
export async function listRecentSessions(clubId: string): Promise<SessionListItem[]> {
  const scoped = createClubScopedClient(clubId);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: sessions, error: sessionsError } = await scoped
    .from("session")
    .select("id, title, starts_at, cancelled_at")
    .gte("starts_at", thirtyDaysAgo)
    .or(`cancelled_at.is.null,cancelled_at.gt.${thirtyMinutesAgo}`)
    .order("starts_at", { ascending: false });
  if (sessionsError) throw sessionsError;
  // See the cast comment in getSessionWithAttendance above.
  const typedSessions = sessions as unknown as {
    id: string;
    title: string;
    starts_at: string;
    cancelled_at: string | null;
  }[];

  const sessionIds = (typedSessions ?? []).map((s) => s.id);
  const countsBySessionId = new Map<string, number>();
  if (sessionIds.length > 0) {
    // Only rows actually marked attended count as "attendees" -- an
    // attendance_record can be unticked (toggleAttendance sets
    // attended:false rather than deleting the row) or come from an
    // eActivities signup nobody showed up to, and the index page's count
    // must agree with what /club/[clubSlug]/sessions/[id] shows for the same session.
    //
    // .range() is set explicitly (rather than relying on the default
    // page size) so PostgREST's default max-rows cap can't silently
    // truncate the count once total attendance across this 30-day window
    // grows past it.
    const { data: attendanceRows, error: attendanceError } = await scoped
      .from("attendance_record")
      .select("session_id")
      .eq("attended", true)
      .in("session_id", sessionIds)
      .range(0, 9999);
    if (attendanceError) throw attendanceError;
    const typedAttendanceRows = attendanceRows as unknown as { session_id: string }[];
    for (const row of typedAttendanceRows ?? []) {
      countsBySessionId.set(row.session_id, (countsBySessionId.get(row.session_id) ?? 0) + 1);
    }
  }

  return (typedSessions ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    startsAt: s.starts_at,
    attendeeCount: countsBySessionId.get(s.id) ?? 0,
    isToday: isUtcToday(s.starts_at),
    isFuture: new Date(s.starts_at).getTime() > Date.now(),
    cancelledAt: s.cancelled_at,
  }));
}
