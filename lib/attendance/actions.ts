"use server";

// Every exported function below calls requireAdmin() first — see
// lib/auth/require-admin.ts and
// docs/superpowers/specs/2026-09-19-admin-auth-design.md. This replaces the
// SECURITY — TRACKED GAP note that was here before admin auth was built.

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import { syncSessionAttendance } from "@/lib/attendance/sync";
import { getSessionWithAttendance } from "@/lib/attendance/queries";
import { requireAdmin } from "@/lib/auth/require-admin";

const provider = new EactivitiesProvider();

// ---------------------------------------------------------------------------
// 3.0 — session creation / signup binding (AC-8)
// ---------------------------------------------------------------------------

export async function getEventSignups(eventId: string) {
  await requireAdmin();
  const event = await provider.getEvent(eventId);
  return {
    id: event.ID,
    title: event.Title,
    startsAt: event.EventStart,
    signups: event.Signups.map((s) => ({
      id: s.ID,
      title: s.Title,
      attendeesCount: s.AttendeesCount,
      maximumAttendees: s.MaximumAttendees,
    })),
  };
}

const createSessionSchema = z.object({
  eventId: z.string().min(1),
  signupId: z.string().min(1),
  title: z.string().min(1).max(200),
  startsAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
});

export async function createSessionFromSignup(
  input: z.infer<typeof createSessionSchema>
): Promise<{ sessionId: string }> {
  await requireAdmin();
  const parsed = createSessionSchema.parse(input);
  const admin = createAdminClient();

  const { data: session, error } = await admin
    .from("session")
    .insert({
      eactivities_event_id: parsed.eventId,
      eactivities_signup_id: parsed.signupId,
      title: parsed.title,
      starts_at: new Date(parsed.startsAt).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;

  // Best-effort initial sync so the attendance screen isn't empty on first
  // load — AC-1. If this fails (e.g. eActivities down), session creation
  // still succeeds; the screen falls back to the manual "Sync now" button.
  try {
    await syncSessionAttendance(session.id);
  } catch {
    // swallow — non-fatal, see comment above
  }

  return { sessionId: session.id };
}

// ---------------------------------------------------------------------------
// 3.2 — attendance toggle (AC-2)
// ---------------------------------------------------------------------------

const toggleSchema = z.object({
  sessionId: z.string().uuid(),
  personId: z.string().uuid(),
  attended: z.boolean(),
});

export async function toggleAttendance(input: z.infer<typeof toggleSchema>) {
  await requireAdmin();
  const { sessionId, personId, attended } = toggleSchema.parse(input);
  const admin = createAdminClient();

  // Unlike the sync's ON CONFLICT DO NOTHING (never overwrite an existing
  // tick), this IS the admin's explicit action — DO UPDATE is correct here.
  // Idempotent per AC-2: toggling to the same value twice is a no-op change.
  const { error } = await admin.from("attendance_record").upsert(
    {
      person_id: personId,
      session_id: sessionId,
      attended,
      source: "manual_tick",
      recorded_at: new Date().toISOString(),
    },
    { onConflict: "person_id,session_id" }
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 3.4 — fuzzy name search (AC-4)
// ---------------------------------------------------------------------------

const searchSchema = z.string().min(1).max(200);

export interface PersonSearchResult {
  id: string;
  fullName: string;
  email: string;
  cid: string | null;
  similarity: number;
}

export async function searchPeople(query: string): Promise<PersonSearchResult[]> {
  await requireAdmin();
  const parsed = searchSchema.parse(query);
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("search_person_by_name", {
    search_query: parsed,
  });
  if (error) throw error;

  interface SearchRow {
    id: string;
    full_name: string;
    email: string;
    cid: string | null;
    similarity: number;
  }

  return ((data as SearchRow[]) ?? []).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    cid: row.cid,
    similarity: row.similarity,
  }));
}

export async function addExistingPersonToSession(sessionId: string, personId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("attendance_record").upsert(
    {
      person_id: personId,
      session_id: sessionId,
      attended: true,
      source: "manual_tick",
    },
    { onConflict: "person_id,session_id" }
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 3.5 — walk-in creation (AC-5)
// ---------------------------------------------------------------------------

const walkInSchema = z.object({
  sessionId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string().min(1).max(200),
  shortcode: z.string().max(50).optional(),
});

export async function createWalkIn(
  input: z.infer<typeof walkInSchema>
): Promise<{ personId: string; reusedExisting: boolean }> {
  await requireAdmin();
  const { sessionId, email, fullName, shortcode } = walkInSchema.parse(input);
  const admin = createAdminClient();

  // Someone searching the roster only sees people already on *this*
  // session's list filtered out (see AddAttendee) — they can still land
  // here via "create new person" for someone who already exists in the
  // `person` table generally (a different session, or added before this
  // one existed). person.email has no DB-level unique constraint, so
  // without this check every such case would silently create a duplicate
  // person row instead of reusing the real one.
  const { data: existing, error: existingError } = await admin
    .from("person")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (existingError) throw existingError;

  let personId: string;
  if (existing) {
    personId = existing.id;
  } else {
    const { data: person, error: personError } = await admin
      .from("person")
      .insert({
        email,
        full_name: fullName,
        shortcode: shortcode || null,
        identity_confidence: "provisional",
      })
      .select("id")
      .single();
    if (personError) throw personError;
    personId = person.id;
  }

  const { error: attendanceError } = await admin.from("attendance_record").upsert(
    {
      person_id: personId,
      session_id: sessionId,
      attended: true,
      source: existing ? "manual_tick" : "walk_in",
    },
    { onConflict: "person_id,session_id" }
  );
  if (attendanceError) throw attendanceError;

  return { personId, reusedExisting: !!existing };
}

// ---------------------------------------------------------------------------
// manual sync trigger (AC-6) — calls syncSessionAttendance directly rather
// than the HTTP route: a Server Action is already server-only and
// CSRF-protected by Next.js, so it doesn't need SYNC_TRIGGER_SECRET. That
// route stays available for any non-UI caller; the UI just doesn't use it.
// ---------------------------------------------------------------------------

export async function triggerManualSync(sessionId: string) {
  await requireAdmin();
  return syncSessionAttendance(sessionId);
}

// Client-callable wrapper around getSessionWithAttendance — used to refetch
// after a Realtime INSERT, since the raw postgres_changes payload only has
// attendance_record's own columns (person_id), not the joined person name/
// email needed to render a new row. See attendance-screen.tsx.
export async function getAttendanceList(sessionId: string) {
  await requireAdmin();
  const session = await getSessionWithAttendance(sessionId);
  return session?.attendance ?? [];
}
