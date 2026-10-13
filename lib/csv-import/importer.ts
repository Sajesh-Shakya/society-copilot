import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikePattern } from "@/lib/utils";
import type { AttendeeRow } from "./parser";

// Mirrors lib/attendance/actions.ts's createSessionFromSignup schema for
// startsAt (accept either an offset-qualified ISO datetime or any
// non-empty string the caller has already normalized).
export const createSessionFromCsvSchema = z.object({
  title: z.string().min(1).max(200),
  startsAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
});

export interface ImportAttendanceCsvInput {
  title: string;
  startsAt: string;
  rows: AttendeeRow[];
}

export interface ImportAttendanceCsvResult {
  sessionId: string;
  imported: number;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Matches a CSV row to an existing person by email (case-insensitive,
 * wildcard-escaped -- see lib/utils.ts's escapeIlikePattern), creating one
 * if none exists. Shared by both the create-new-session and append-to-
 * existing-session import paths so they match/create people identically.
 */
async function findOrCreatePersonByEmail(admin: AdminClient, row: AttendeeRow): Promise<string> {
  const email = row.email.toLowerCase();
  const { data: existing, error: lookupError } = await admin
    .from("person")
    .select("id")
    .ilike("email", escapeIlikePattern(email))
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) return existing.id;

  const { data: created, error: personError } = await admin
    .from("person")
    .insert({
      email: row.email,
      full_name: `${row.firstName} ${row.surname}`.trim(),
      identity_confidence: "confirmed",
    })
    .select("id")
    .single();
  if (personError) throw personError;
  return created.id;
}

/**
 * Pure DB-writing logic for the CSV-import fail-safe (see the 2026-10-09
 * design doc) -- no requireAdmin() call here, deliberately, so integration
 * tests can call it directly. The "use server" action in actions.ts is the
 * only production caller and is responsible for the admin check, CSV
 * parsing, and translating a thrown error here into a user-facing message.
 *
 * Creates a brand-new session (eactivities_event_id/signup_id left null)
 * and one attendance_record per row (source: 'csv_import', attended:
 * false -- see the design doc's "blank Attended column means unknown, not
 * attended" decision). Matches/creates person rows by email only; CID/Card
 * Number is never used to match, only stored for audit.
 *
 * Not wrapped in a transaction (no code in this codebase uses one --
 * Supabase-js doesn't expose multi-statement transactions directly, and
 * every other multi-step write here, e.g. createSessionFromSignup, accepts
 * the same partial-failure risk). A thrown error partway through leaves
 * the session and whatever rows succeeded so far in place; the caller
 * surfaces this as a failure and the admin can inspect/retry.
 */
export async function importAttendanceCsv(
  input: ImportAttendanceCsvInput
): Promise<ImportAttendanceCsvResult> {
  const admin = createAdminClient();

  const { data: session, error: sessionError } = await admin
    .from("session")
    .insert({ title: input.title, starts_at: new Date(input.startsAt).toISOString() })
    .select("id")
    .single();
  if (sessionError) throw sessionError;

  for (const row of input.rows) {
    const personId = await findOrCreatePersonByEmail(admin, row);

    const { error: attendanceError } = await admin.from("attendance_record").insert({
      person_id: personId,
      session_id: session.id,
      source: "csv_import",
      attended: false,
      raw_cid_or_card_number: row.rawCidOrCardNumber,
    });
    if (attendanceError) throw attendanceError;
  }

  return { sessionId: session.id, imported: input.rows.length };
}

export interface AppendAttendanceCsvInput {
  sessionId: string;
  rows: AttendeeRow[];
}

export interface AppendAttendanceCsvResult {
  added: number;
  skipped: number;
}

/**
 * Appends CSV rows to an EXISTING session's roster -- for new people who
 * sign up after the session was first created/imported. Unlike
 * importAttendanceCsv, a row whose person already has an attendance_record
 * for this session is silently skipped rather than erroring or overwriting
 * -- re-uploading the same (or an overlapping) file must never reset
 * someone who's already been ticked, or stomp on their recorded source.
 * Mirrors the live-sync path's ON CONFLICT DO NOTHING semantics (see
 * lib/attendance/sync.ts).
 *
 * No requireAdmin() here either, for the same testability reason as
 * importAttendanceCsv above.
 */
export async function appendAttendanceCsv(
  input: AppendAttendanceCsvInput
): Promise<AppendAttendanceCsvResult> {
  const admin = createAdminClient();

  const records = [];
  for (const row of input.rows) {
    const personId = await findOrCreatePersonByEmail(admin, row);
    records.push({
      person_id: personId,
      session_id: input.sessionId,
      source: "csv_import" as const,
      attended: false,
      raw_cid_or_card_number: row.rawCidOrCardNumber,
    });
  }

  const { data, error } = await admin
    .from("attendance_record")
    .upsert(records, { onConflict: "person_id,session_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;

  const added = data?.length ?? 0;
  return { added, skipped: input.rows.length - added };
}
