import { z } from "zod";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { normalizeCid } from "@/lib/utils";
import { loadPersonIndex } from "@/lib/purchase/person-index";
import { optionalEndsAtSchema, endsAfterStart, endsAfterStartRefinement } from "@/lib/attendance/end-time";
import type { AttendeeRow } from "./parser";

// Mirrors lib/attendance/actions.ts's createSessionFromSignup schema for
// startsAt (accept either an offset-qualified ISO datetime or any
// non-empty string the caller has already normalized).
export const createSessionFromCsvSchema = z
  .object({
    title: z.string().min(1).max(200),
    startsAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
    endsAt: optionalEndsAtSchema,
  })
  .refine(endsAfterStart, endsAfterStartRefinement);

export interface ImportAttendanceCsvInput {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  rows: AttendeeRow[];
}

export interface ImportAttendanceCsvResult {
  sessionId: string;
  imported: number;
}

/**
 * Resolves every CSV row to a person id (returned in `rows` order) from one
 * in-memory person index instead of per-row lookups. Shared by both the
 * create-new-session and append-to-existing-session import paths so they
 * match/create people identically.
 *
 * Matching rules are exactly those of the per-row function this replaced:
 * CID first (normalised), then email (case-insensitive). The CID is a real
 * 8-digit Imperial CID, and person_cid_unique_idx (WHERE cid IS NOT NULL)
 * rejects two people sharing one, so a row signing up again under a
 * different email must resolve to the existing CID owner, not insert.
 *
 * When matched by email and the row carries a CID the person lacks, the CID
 * is backfilled (one update per affected person). Never overwrites an
 * existing cid or email -- whichever key found the match is trusted; the
 * other field a row carries is additional evidence only.
 *
 * Rows that match nobody become new people (identity_confidence
 * "confirmed") created in ONE bulk insert. Within the file, a later row whose
 * CID or email equals an earlier would-be-new row maps to that same new
 * person (the old code found the just-inserted person the same way).
 */
export async function resolvePeopleForRows(clubId: string, rows: AttendeeRow[]): Promise<string[]> {
  const scoped = createClubScopedClient(clubId);
  const index = await loadPersonIndex(clubId);

  interface PendingPerson {
    email: string;
    fullName: string;
    cid: string | null;
  }
  const pending: PendingPerson[] = [];
  const pendingByCid = new Map<string, number>();
  const pendingByEmail = new Map<string, number>();
  // Per row: either a resolved id or the index of a pending new person.
  const resolved: Array<{ id: string } | { pendingIdx: number }> = [];
  const backfills = new Map<string, string>(); // person id -> cid

  for (const row of rows) {
    const email = row.email.toLowerCase();
    const cid = row.rawCidOrCardNumber ? normalizeCid(row.rawCidOrCardNumber) : null;

    if (cid) {
      const id = index.byCid.get(cid);
      if (id) {
        resolved.push({ id });
        continue;
      }
      const pendingIdx = pendingByCid.get(cid);
      if (pendingIdx !== undefined) {
        resolved.push({ pendingIdx });
        continue;
      }
    }

    // The old per-row lookup used maybeSingle() and threw on its error, so
    // an email shared by 2+ people fails the import rather than guessing.
    if (index.ambiguousEmails.has(email)) {
      throw new Error(`Multiple people share the email "${row.email}"; cannot match this row`);
    }
    const emailId = index.byEmail.get(email);
    if (emailId) {
      if (cid && !index.cidById.get(emailId)) {
        backfills.set(emailId, cid);
        index.cidById.set(emailId, cid);
        index.byCid.set(cid, emailId);
      }
      resolved.push({ id: emailId });
      continue;
    }
    const pendingEmailIdx = pendingByEmail.get(email);
    if (pendingEmailIdx !== undefined) {
      const p = pending[pendingEmailIdx];
      if (cid && !p.cid) {
        p.cid = cid;
        pendingByCid.set(cid, pendingEmailIdx);
      }
      resolved.push({ pendingIdx: pendingEmailIdx });
      continue;
    }

    const pendingIdx = pending.length;
    pending.push({ email: row.email, fullName: `${row.firstName} ${row.surname}`.trim(), cid });
    pendingByEmail.set(email, pendingIdx);
    if (cid) pendingByCid.set(cid, pendingIdx);
    resolved.push({ pendingIdx });
  }

  for (const [personId, cid] of backfills) {
    const { error } = await scoped.from("person").update({ cid }).eq("id", personId);
    if (error) throw error;
  }

  let createdIds: string[] = [];
  if (pending.length > 0) {
    const { data, error } = await scoped
      .from("person")
      .insert(
        pending.map((p) => ({
          email: p.email,
          full_name: p.fullName,
          identity_confidence: "confirmed",
          cid: p.cid,
        }))
      )
      .select("id, email, cid");
    if (error) throw error;
    // PostgREST returns inserted rows in input order.
    createdIds = ((data ?? []) as unknown as Array<{ id: string }>).map((r) => r.id);
    if (createdIds.length !== pending.length) {
      throw new Error(`Expected ${pending.length} new people, database returned ${createdIds.length}`);
    }
  }

  return resolved.map((r) => ("id" in r ? r.id : createdIds[r.pendingIdx]));
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
  input: ImportAttendanceCsvInput,
  clubId: string
): Promise<ImportAttendanceCsvResult> {
  const scoped = createClubScopedClient(clubId);

  const { data: session, error: sessionError } = await scoped
    .from("session")
    .insert({
      title: input.title,
      starts_at: new Date(input.startsAt).toISOString(),
      ends_at: input.endsAt ? new Date(input.endsAt).toISOString() : null,
    })
    .select("id")
    .single();
  if (sessionError) throw sessionError;
  const typedSession = session as unknown as { id: string };

  const personIds = await resolvePeopleForRows(clubId, input.rows);

  const ATTENDANCE_CHUNK_SIZE = 500;
  for (let start = 0; start < input.rows.length; start += ATTENDANCE_CHUNK_SIZE) {
    const chunk = input.rows.slice(start, start + ATTENDANCE_CHUNK_SIZE).map((row, i) => ({
      person_id: personIds[start + i],
      session_id: typedSession.id,
      source: "csv_import" as const,
      attended: false,
      raw_cid_or_card_number: row.rawCidOrCardNumber,
    }));
    const { error: attendanceError } = await scoped.from("attendance_record").insert(chunk);
    if (attendanceError) throw attendanceError;
  }

  return { sessionId: typedSession.id, imported: input.rows.length };
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
  input: SyncAttendanceCsvInput,
  clubId: string
): Promise<SyncAttendanceCsvResult> {
  const scoped = createClubScopedClient(clubId);

  const personIds = await resolvePeopleForRows(clubId, input.rows);
  const records = input.rows.map((row, i) => ({
    person_id: personIds[i],
    session_id: input.sessionId,
    source: "csv_import" as const,
    attended: false,
    raw_cid_or_card_number: row.rawCidOrCardNumber,
  }));

  const { data: upserted, error: upsertError } = await scoped
    .from("attendance_record")
    .upsert(records, { onConflict: "person_id,session_id", ignoreDuplicates: true })
    .select("id");
  if (upsertError) throw upsertError;
  const added = upserted?.length ?? 0;

  const newEmails = new Set(input.rows.map((row) => row.email.toLowerCase()));

  const { data: existingCsvRows, error: existingError } = await scoped
    .from("attendance_record")
    .select("id, person:person_id(email)")
    .eq("session_id", input.sessionId)
    .eq("source", "csv_import")
    .eq("attended", false);
  if (existingError) throw existingError;

  const typedExistingCsvRows = (existingCsvRows ?? []) as unknown as Array<{
    id: string;
    person: { email: string } | { email: string }[];
  }>;

  const idsToRemove = typedExistingCsvRows
    .filter((record) => {
      // supabase-js types a to-one FK select as an array; it's always
      // exactly one row here since person_id is not-null with a FK.
      const person = Array.isArray(record.person) ? record.person[0] : record.person;
      return !newEmails.has(person.email.toLowerCase());
    })
    .map((record) => record.id);

  let removed = 0;
  if (idsToRemove.length > 0) {
    // createClubScopedClient's delete() wrapper takes no options (unlike
    // the raw admin client's delete({ count: "exact" })), so there's no
    // DB-reported count to read here. Falling back to idsToRemove.length
    // is equivalent in practice: those ids were just fetched moments ago
    // under the same club scope, and .in() deletes exactly the rows that
    // still match.
    const { error: deleteError } = await scoped
      .from("attendance_record")
      .delete()
      .in("id", idsToRemove);
    if (deleteError) throw deleteError;
    removed = idsToRemove.length;
  }

  return { added, skipped: input.rows.length - added, removed };
}
