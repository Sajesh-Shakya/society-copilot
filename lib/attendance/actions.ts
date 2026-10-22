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
import { escapeIlikePattern, normalizeCid } from "@/lib/utils";
import { reapplyWaiversForPerson } from "@/lib/purchase/interface";

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
  // tick), this IS the admin's explicit action — a DO UPDATE is correct
  // here. Idempotent per AC-2: toggling to the same value twice is a no-op
  // change.
  //
  // Supabase-js's .upsert() can't express "don't touch this column on
  // conflict" -- it always writes every column it's given. Ticking a
  // csv_import/signup_sync row would therefore unconditionally overwrite
  // its source to manual_tick, erasing the provenance that's the whole
  // point of recording a non-manual source. So: look the row up first; an
  // existing row gets a real UPDATE that only touches attended/
  // recorded_at (source untouched); only a brand-new row gets source:
  // "manual_tick".
  const { data: existing, error: lookupError } = await admin
    .from("attendance_record")
    .select("id")
    .eq("person_id", personId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    const { error } = await admin
      .from("attendance_record")
      .update({ attended, recorded_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await admin.from("attendance_record").insert({
      person_id: personId,
      session_id: sessionId,
      attended,
      source: "manual_tick",
      recorded_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  // Ticking someone attended can turn a row into fresh outstanding debt
  // (a CSV-imported roster row starts attended: false, so it's only debt
  // from this moment on) -- re-check whether any purchase already
  // matched to this person, bought before this tick, has leftover
  // capacity to cover it. See reapplyWaiversForPerson's doc comment.
  if (attended) {
    await reapplyWaiversForPerson(personId);
  }
}

// ---------------------------------------------------------------------------
// Session cancellation (soft delete) — cancelling an event (e.g. the club
// calls off Wednesday's session) sets a flag rather than deleting the row,
// so any roster/attendance already attached to it is never lost. Toggled
// rather than one-way so an accidental cancel is reversible.
// ---------------------------------------------------------------------------

const setSessionCancelledSchema = z.object({
  sessionId: z.string().uuid(),
  cancelled: z.boolean(),
});

export async function setSessionCancelled(
  input: z.infer<typeof setSessionCancelledSchema>
) {
  await requireAdmin();
  const { sessionId, cancelled } = setSessionCancelledSchema.parse(input);
  const admin = createAdminClient();

  const { error } = await admin
    .from("session")
    .update({ cancelled_at: cancelled ? new Date().toISOString() : null })
    .eq("id", sessionId);
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

  await reapplyWaiversForPerson(personId);
}

// ---------------------------------------------------------------------------
// 3.5 — walk-in creation (AC-5)
// ---------------------------------------------------------------------------

const walkInSchema = z.object({
  sessionId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string().min(1).max(200),
  // An external/non-member guest won't have one (they can't sign up via
  // eActivities' whatson at all, hence walk-in) -- a student who is one
  // might, and capturing it here is what lets a later purchase (lib/
  // purchase/matcher.ts's CID match) actually find them.
  cid: z.string().max(20).optional(),
});

export async function createWalkIn(
  input: z.infer<typeof walkInSchema>
): Promise<{ personId: string; reusedExisting: boolean }> {
  await requireAdmin();
  const { sessionId, email, fullName, cid: rawCid } = walkInSchema.parse(input);
  const cid = rawCid ? normalizeCid(rawCid) : null;
  const admin = createAdminClient();

  // CID first, if given -- mirrors lib/attendance/sync.ts's identity
  // priority (CID is the one identifier this codebase actually trusts).
  // Falls back to email -- someone searching the roster only sees people
  // already on *this* session's list filtered out (see AddAttendee),
  // they can still land here via "create new person" for someone who
  // already exists in the `person` table generally (a different session,
  // or added before this one existed). person.email has no DB-level
  // unique constraint, so without this check every such case would
  // silently create a duplicate person row instead of reusing the real
  // one.
  let existing: { id: string; cid: string | null } | null = null;
  if (cid) {
    const { data, error } = await admin.from("person").select("id, cid").eq("cid", cid).maybeSingle();
    if (error) throw error;
    existing = data;
  }
  if (!existing) {
    const { data, error } = await admin
      .from("person")
      .select("id, cid")
      .ilike("email", escapeIlikePattern(email))
      .maybeSingle();
    if (error) throw error;
    existing = data;
  }

  let personId: string;
  if (existing) {
    personId = existing.id;
    if (cid && !existing.cid) {
      const { error: backfillError } = await admin.from("person").update({ cid }).eq("id", existing.id);
      if (backfillError) throw backfillError;
    }
  } else {
    const { data: person, error: personError } = await admin
      .from("person")
      .insert({
        email,
        full_name: fullName,
        cid,
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

  await reapplyWaiversForPerson(personId);

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
