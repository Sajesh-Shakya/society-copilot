import { createAdminClient } from "@/lib/supabase/admin";

// Caller identity is checked in app/sessions/[sessionId]/page.tsx (the only
// caller) before this runs — see lib/auth/require-admin.ts.

export interface AttendanceRow {
  attendanceRecordId: string;
  personId: string;
  fullName: string;
  email: string;
  attended: boolean;
  source: "signup_sync" | "manual_tick" | "walk_in";
}

export interface SessionWithAttendance {
  id: string;
  title: string;
  startsAt: string;
  eactivitiesSignupId: string | null;
  lastSyncedAt: string | null;
  attendance: AttendanceRow[];
}

/**
 * Server-only read (admin client — person/session are deny-all RLS). Used by
 * app/sessions/[sessionId]/page.tsx as the initial render; the client then
 * layers Realtime updates on top (see components/attendance/attendance-screen.tsx).
 */
export async function getSessionWithAttendance(
  sessionId: string
): Promise<SessionWithAttendance | null> {
  const admin = createAdminClient();

  const { data: session, error: sessionError } = await admin
    .from("session")
    .select("id, title, starts_at, eactivities_signup_id, last_synced_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return null;

  const { data: records, error: recordsError } = await admin
    .from("attendance_record")
    .select("id, attended, source, person:person_id(id, full_name, email)")
    .eq("session_id", sessionId);
  if (recordsError) throw recordsError;

  const attendance: AttendanceRow[] = (records ?? [])
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
    id: session.id,
    title: session.title,
    startsAt: session.starts_at,
    eactivitiesSignupId: session.eactivities_signup_id,
    lastSyncedAt: session.last_synced_at,
    attendance,
  };
}

export interface SessionListItem {
  id: string;
  title: string;
  startsAt: string;
  attendeeCount: number;
  isToday: boolean;
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
 */
export async function listRecentSessions(): Promise<SessionListItem[]> {
  const admin = createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: sessions, error: sessionsError } = await admin
    .from("session")
    .select("id, title, starts_at")
    .gte("starts_at", thirtyDaysAgo)
    .order("starts_at", { ascending: false });
  if (sessionsError) throw sessionsError;

  const sessionIds = (sessions ?? []).map((s) => s.id);
  const countsBySessionId = new Map<string, number>();
  if (sessionIds.length > 0) {
    // Only rows actually marked attended count as "attendees" -- an
    // attendance_record can be unticked (toggleAttendance sets
    // attended:false rather than deleting the row) or come from an
    // eActivities signup nobody showed up to, and the index page's count
    // must agree with what /sessions/[id] shows for the same session.
    //
    // .range() is set explicitly (rather than relying on the default
    // page size) so PostgREST's default max-rows cap can't silently
    // truncate the count once total attendance across this 30-day window
    // grows past it.
    const { data: attendanceRows, error: attendanceError } = await admin
      .from("attendance_record")
      .select("session_id")
      .eq("attended", true)
      .in("session_id", sessionIds)
      .range(0, 9999);
    if (attendanceError) throw attendanceError;
    for (const row of attendanceRows ?? []) {
      countsBySessionId.set(row.session_id, (countsBySessionId.get(row.session_id) ?? 0) + 1);
    }
  }

  return (sessions ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    startsAt: s.starts_at,
    attendeeCount: countsBySessionId.get(s.id) ?? 0,
    isToday: isUtcToday(s.starts_at),
  }));
}
