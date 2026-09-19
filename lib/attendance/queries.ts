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
