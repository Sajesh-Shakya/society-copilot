import { createAdminClient } from "@/lib/supabase/admin";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { assertSessionBelongsToClub } from "@/lib/attendance/queries";
import { escapeIlikePattern } from "@/lib/utils";
import { reapplyWaiversForPerson } from "@/lib/purchase/interface";
import { walkInSchema, firstWalkInError } from "@/lib/identity/walk-in-schema";
import { applyCidEvidence } from "@/lib/identity/apply-cid-evidence";

export type WalkInResult = { personId: string; reusedExisting: boolean } | { error: string };

/**
 * The logic behind the createWalkIn Server Action (lib/attendance/actions.ts),
 * which calls requireAdmin() and then this. Kept outside the "use server" file
 * so it can be exercised directly by integration tests.
 *
 * Validation failures are returned as `{ error }` (an expected error, shown to
 * the admin); anything else throws.
 */
export async function createWalkInForClub(clubId: string, input: unknown): Promise<WalkInResult> {
  const parsed = walkInSchema.safeParse(input);
  if (!parsed.success) return { error: firstWalkInError(parsed.error) };
  // walkInSchema already normalised the CID (7 digits -> 8) and collapsed
  // whitespace in the name; an empty CID arrives as undefined.
  const { sessionId, email, fullName, cid } = parsed.data;
  await assertSessionBelongsToClub(sessionId, clubId);
  const scoped = createClubScopedClient(clubId);

  // CID first, if given -- mirrors lib/attendance/sync.ts's identity
  // priority (CID is the one identifier this codebase actually trusts).
  // Falls back to email -- someone searching the roster only sees people
  // already on *this* session's list filtered out (see AddAttendee),
  // they can still land here via "create new person" for someone who
  // already exists in the `person` table generally (a different session,
  // or added before this one existed). person.email has no DB-level
  // unique constraint, so without this check every such case would
  // silently create a duplicate person row instead of reusing the real
  // one. Never matched by name.
  // createClubScopedClient's select() wrapper types `columns` as a plain
  // `string` rather than a literal, so supabase-js can't statically parse
  // the query -- same cast-after-fetch convention as lib/attendance/sync.ts
  // and lib/attendance/queries.ts.
  let existing: { id: string; cid: string | null } | null = null;
  let matchedByCid = false;
  if (cid) {
    const { data, error } = await scoped.from("person").select("id, cid").eq("cid", cid).maybeSingle();
    if (error) throw error;
    existing = data as unknown as { id: string; cid: string | null } | null;
    matchedByCid = !!existing;
  }
  if (!existing) {
    const { data, error } = await scoped
      .from("person")
      .select("id, cid")
      .ilike("email", escapeIlikePattern(email))
      .maybeSingle();
    if (error) throw error;
    existing = data as unknown as { id: string; cid: string | null } | null;
  }

  let personId: string;
  if (existing) {
    personId = existing.id;
    // A typed CID on an email-matched person is walk-in evidence: the trust
    // rule decides whether it fills, is ignored, or is flagged (a walk-in
    // never overwrites a better-sourced CID). A CID-matched person already
    // has this CID, so there is nothing to apply.
    if (cid && !matchedByCid) {
      await applyCidEvidence(scoped, existing.id, cid, "walk_in");
    }
  } else {
    const { data: person, error: personError } = await scoped
      .from("person")
      .insert({
        email,
        full_name: fullName,
        cid: cid ?? null,
        cid_source: cid ? "walk_in" : null,
        identity_confidence: "provisional",
      })
      .select("id")
      .single();
    if (personError) throw personError;
    personId = (person as unknown as { id: string }).id;
  }

  // attendance_record's unique(person_id, session_id) constraint has no
  // club_id in it and never crosses a club boundary (person_id and
  // session_id both belong to a single club via the same-club FKs), so the
  // scoped upsert() wrapper's onConflict/ignoreDuplicates requirement
  // doesn't apply and would force the wrong (DO-NOTHING) semantics here.
  // sessionId was verified via assertSessionBelongsToClub above; personId is
  // either freshly inserted via the scoped client (so already this club) or
  // an `existing` row found via a scoped lookup.
  const admin = createAdminClient();
  const { error: attendanceError } = await admin.from("attendance_record").upsert(
    {
      club_id: clubId,
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
