import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikePattern, normalizeCid } from "@/lib/utils";
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
 * Matches a CSV row to an existing person, creating one if none exists.
 * Shared by both the create-new-session and append-to-existing-session
 * import paths so they match/create people identically.
 *
 * CID first, then email -- mirrors the priority lib/attendance/sync.ts's
 * findOrCreatePerson and lib/attendance/actions.ts's createWalkIn already
 * use. This USED to be email-only (per the 2026-10-09 design doc, written
 * when the CSV's CID/Card Number column was still considered too
 * unreliable to match on); that assumption was checked empirically on
 * 2026-10-16 and found to not hold -- it's reliably a clean 8-digit
 * Imperial CID once zero-padded. Email-only broke in production exactly
 * the way CID-only matching would never have: a real person (CID already
 * on file from an earlier import) signed up again under a different
 * email, email-only matching correctly found no existing person for that
 * email and tried to INSERT a new one, and person.cid's unique index
 * (person_cid_unique_idx, WHERE cid IS NOT NULL) rejected it outright --
 * aborting the whole import partway through, since this function's
 * caller writes no transaction boundary around the per-row loop.
 *
 * Also backfills person.cid when matched by email and the person doesn't
 * already have one -- for anyone created via CSV import before CID was
 * trusted enough to match on, which otherwise left purchase-record CID
 * matching (lib/purchase/matcher.ts) with nothing to match against.
 * Never overwrites an existing cid or email -- whichever key found the
 * match is trusted; the other field a row carries is additional evidence,
 * not grounds to silently rewrite someone's contact email or override a
 * previously-confirmed CID.
 */
async function findOrCreatePersonByEmail(admin: AdminClient, row: AttendeeRow): Promise<string> {
  const email = row.email.toLowerCase();
  const cid = row.rawCidOrCardNumber ? normalizeCid(row.rawCidOrCardNumber) : null;

  if (cid) {
    const { data: byCid, error: cidLookupError } = await admin
      .from("person")
      .select("id")
      .eq("cid", cid)
      .maybeSingle();
    if (cidLookupError) throw cidLookupError;
    if (byCid) return byCid.id;
  }

  const { data: byEmail, error: emailLookupError } = await admin
    .from("person")
    .select("id, cid")
    .ilike("email", escapeIlikePattern(email))
    .maybeSingle();
  if (emailLookupError) throw emailLookupError;

  if (byEmail) {
    if (cid && !byEmail.cid) {
      const { error: backfillError } = await admin.from("person").update({ cid }).eq("id", byEmail.id);
      if (backfillError) throw backfillError;
    }
    return byEmail.id;
  }

  const { data: created, error: personError } = await admin
    .from("person")
    .insert({
      email: row.email,
      full_name: `${row.firstName} ${row.surname}`.trim(),
      identity_confidence: "confirmed",
      cid,
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

export interface SyncAttendanceCsvInput {
  sessionId: string;
  rows: AttendeeRow[];
}

export interface SyncAttendanceCsvResult {
  added: number;
  skipped: number;
  removed: number;
}

/**
 * Re-syncs an EXISTING session's roster against a freshly re-exported CSV
 * -- eActivities' signup list is live, so someone who signed up when the
 * session was first imported may have un-signed-up by the time of a later
 * export. The new file is treated as authoritative for who's currently
 * signed up:
 *
 * - A row not already on the roster is added (source: 'csv_import',
 *   attended: false), same as importAttendanceCsv.
 * - A row already on the roster is left untouched (no re-insert, no
 *   overwrite -- mirrors the live-sync path's ON CONFLICT DO NOTHING
 *   semantics, see lib/attendance/sync.ts).
 * - An existing attendance_record is removed ONLY if it came from a
 *   previous CSV import (source: 'csv_import'), the person is NOT in this
 *   new file, AND they haven't been marked attended yet. This is
 *   deliberately narrow: a `manual_tick`/`walk_in` row is never removed
 *   (that person was never on any signup list, so their absence from one
 *   export says nothing about them), and an already-attended csv_import
 *   row is never removed either (real recorded attendance outranks a
 *   stale export -- see the design doc's "blank Attended column means
 *   unknown, not attended" decision this mirrors).
 *
 * No requireAdmin() here either, for the same testability reason as
 * importAttendanceCsv above.
 */
export async function syncAttendanceCsv(
  input: SyncAttendanceCsvInput
): Promise<SyncAttendanceCsvResult> {
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

  const { data: upserted, error: upsertError } = await admin
    .from("attendance_record")
    .upsert(records, { onConflict: "person_id,session_id", ignoreDuplicates: true })
    .select("id");
  if (upsertError) throw upsertError;
  const added = upserted?.length ?? 0;

  const newEmails = new Set(input.rows.map((row) => row.email.toLowerCase()));

  const { data: existingCsvRows, error: existingError } = await admin
    .from("attendance_record")
    .select("id, person:person_id(email)")
    .eq("session_id", input.sessionId)
    .eq("source", "csv_import")
    .eq("attended", false);
  if (existingError) throw existingError;

  const idsToRemove = (existingCsvRows ?? [])
    .filter((record) => {
      // supabase-js types a to-one FK select as an array; it's always
      // exactly one row here since person_id is not-null with a FK.
      const person = Array.isArray(record.person) ? record.person[0] : record.person;
      return !newEmails.has(person.email.toLowerCase());
    })
    .map((record) => record.id);

  let removed = 0;
  if (idsToRemove.length > 0) {
    const { error: deleteError, count } = await admin
      .from("attendance_record")
      .delete({ count: "exact" })
      .in("id", idsToRemove);
    if (deleteError) throw deleteError;
    removed = count ?? idsToRemove.length;
  }

  return { added, skipped: input.rows.length - added, removed };
}
