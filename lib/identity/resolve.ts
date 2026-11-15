/**
 * The writers behind the people-review Server Actions (lib/identity/actions.ts
 * calls requireAdmin() first, then these). Every read and write goes through
 * the club-scoped client, so an id from another club is "not found".
 */

import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { outranks, type CidSource } from "@/lib/identity/cid-rule";
import { UNIQUE_VIOLATION, type ScopedClient } from "@/lib/identity/conflicts";

export const CONFLICT_NOT_FOUND = "Conflict not found";
export const CONFLICT_NOT_OPEN = "Conflict is not open";
export const CID_TAKEN = "That CID is now held by someone else";
export const NO_OTHER_PERSON = "Conflict has no other person";
export const HOLDER_NOT_OUTRANKED = "The other person's CID is as trusted as the incoming one";
export const HOLDER_CHANGED = "The other person no longer holds that CID";
export const PERSON_CHANGED = "This person's CID changed since the conflict was recorded";

type ConflictForResolve = {
  id: string;
  person_id: string;
  incoming_cid: string;
  incoming_source: CidSource;
  other_person_id: string | null;
  outcome: string;
  status: string;
};

type PersonCid = { id: string; cid: string | null; cid_source: CidSource | null };

/** Adds `col = value` (or `col IS NULL`) so an update only lands on the state that was read. */
function guard<Q extends { eq(c: string, v: string): Q; is(c: string, v: null): Q }>(
  q: Q,
  col: string,
  value: string | null,
): Q {
  return value === null ? q.is(col, null) : q.eq(col, value);
}

/** Loads an open flagged conflict in this club; throws CONFLICT_NOT_FOUND / CONFLICT_NOT_OPEN. */
async function loadOpenConflict(scoped: ScopedClient, conflictId: string): Promise<ConflictForResolve> {
  const { data, error } = await scoped
    .from("person_identity_conflict")
    .select("id, person_id, incoming_cid, incoming_source, other_person_id, outcome, status")
    .eq("id", conflictId)
    .maybeSingle();
  if (error) throw error;
  const conflict = data as unknown as ConflictForResolve | null;
  if (!conflict) throw new Error(CONFLICT_NOT_FOUND);
  if (conflict.outcome !== "flagged" || conflict.status !== "open") throw new Error(CONFLICT_NOT_OPEN);
  return conflict;
}

async function loadPerson(scoped: ScopedClient, personId: string): Promise<PersonCid> {
  const { data, error } = await scoped.from("person").select("id, cid, cid_source").eq("id", personId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(CONFLICT_NOT_FOUND);
  return data as unknown as PersonCid;
}

/** Another person in the club holding `cid`, if any. */
async function findHolder(scoped: ScopedClient, personId: string, cid: string): Promise<string | null> {
  const { data, error } = await scoped.from("person").select("id").eq("cid", cid).neq("id", personId).limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ id: string }>)[0]?.id ?? null;
}

/**
 * Moves an open flagged conflict to `status`, guarded on it still being open
 * (so two admins cannot both act on it). Throws CONFLICT_NOT_OPEN if it no
 * longer is.
 */
async function closeConflict(
  scoped: ScopedClient,
  conflictId: string,
  status: "resolved" | "dismissed",
  by: string,
): Promise<void> {
  const { data, error } = await scoped
    .from("person_identity_conflict")
    .update({ status, resolved_by: by, resolved_at: new Date().toISOString() })
    .eq("id", conflictId)
    .eq("outcome", "flagged")
    .eq("status", "open")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error(CONFLICT_NOT_OPEN);
}

/** Undoes closeConflict after a later step failed, so the conflict stays actionable. */
async function reopenConflict(scoped: ScopedClient, conflictId: string): Promise<void> {
  const { error } = await scoped
    .from("person_identity_conflict")
    .update({ status: "open", resolved_by: null, resolved_at: null })
    .eq("id", conflictId)
    .eq("outcome", "flagged");
  if (error) throw error;
}

/**
 * Guarded CID write on a person: lands only if their cid/cid_source are still
 * what was read. Returns "ok", "changed" (guard missed) or "taken" (unique
 * violation: another person holds the CID).
 */
async function writeCid(
  scoped: ScopedClient,
  person: PersonCid,
  cid: string | null,
  source: CidSource | null,
): Promise<"ok" | "changed" | "taken"> {
  let q = scoped.from("person").update({ cid, cid_source: source }).eq("id", person.id);
  q = guard(q, "cid", person.cid);
  q = guard(q, "cid_source", person.cid_source);
  const { data, error } = await q.select("id");
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return "taken";
    throw error;
  }
  return data && data.length > 0 ? "ok" : "changed";
}

/** "Keep current": dismiss an open flagged conflict; the person's CID is left alone. */
export async function keepCurrent(clubId: string, conflictId: string, by: string): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  await loadOpenConflict(scoped, conflictId);
  await closeConflict(scoped, conflictId, "dismissed", by);
}

/**
 * "Use incoming": only when the incoming CID is free club-wide. Order: claim
 * the conflict (open -> resolved, guarded), then the guarded person write; if
 * that write misses, the conflict is reopened before the error is raised.
 */
export async function useIncoming(clubId: string, conflictId: string, by: string): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  const conflict = await loadOpenConflict(scoped, conflictId);
  const person = await loadPerson(scoped, conflict.person_id);
  if (await findHolder(scoped, person.id, conflict.incoming_cid)) throw new Error(CID_TAKEN);

  await closeConflict(scoped, conflictId, "resolved", by);
  const result = await writeCid(scoped, person, conflict.incoming_cid, conflict.incoming_source);
  if (result !== "ok") {
    await reopenConflict(scoped, conflictId);
    throw new Error(result === "taken" ? CID_TAKEN : PERSON_CHANGED);
  }
}

/**
 * "Take this CID from the other person": only when the conflict names a
 * holder who still holds the incoming CID and the incoming source outranks
 * the holder's cid_source (a null source counts as sso, as in the rule).
 *
 * Order, chosen so any failure leaves a consistent, recorded state:
 *  1. claim the conflict (open -> resolved, guarded) -- stops a second admin;
 *  2. vacate: clear the holder's cid/cid_source (guarded); on a miss, reopen
 *     the conflict and raise (nothing else changed);
 *  3. claim: set the CID on the person (guarded); on a miss, put the holder's
 *     CID back (guarded on it still being empty) and reopen the conflict. If
 *     the holder cannot be restored, the clearing is recorded as an
 *     `overwritten` conflict for the holder before raising, so it is never
 *     silent;
 *  4. record the holder's `overwritten` conflict (resolved).
 */
export async function takeCidFromHolder(clubId: string, conflictId: string, by: string): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  const conflict = await loadOpenConflict(scoped, conflictId);
  if (!conflict.other_person_id) throw new Error(NO_OTHER_PERSON);
  const person = await loadPerson(scoped, conflict.person_id);
  const holder = await loadPerson(scoped, conflict.other_person_id);
  if (holder.cid !== conflict.incoming_cid) throw new Error(HOLDER_CHANGED);
  if (!outranks(conflict.incoming_source, holder.cid_source ?? "sso")) throw new Error(HOLDER_NOT_OUTRANKED);

  const recordHolderOverwrite = async () => {
    const now = new Date().toISOString();
    const { error } = await scoped.from("person_identity_conflict").insert({
      person_id: holder.id,
      existing_cid: holder.cid,
      existing_source: holder.cid_source,
      incoming_cid: conflict.incoming_cid,
      incoming_source: conflict.incoming_source,
      other_person_id: person.id,
      outcome: "overwritten",
      status: "resolved",
      resolved_by: by,
      resolved_at: now,
    });
    if (error) throw error;
  };

  await closeConflict(scoped, conflictId, "resolved", by);

  const vacated = await writeCid(scoped, holder, null, null);
  if (vacated !== "ok") {
    await reopenConflict(scoped, conflictId);
    throw new Error(HOLDER_CHANGED);
  }

  const claimed = await writeCid(scoped, person, conflict.incoming_cid, conflict.incoming_source);
  if (claimed !== "ok") {
    const restored = await writeCid(scoped, { id: holder.id, cid: null, cid_source: null }, holder.cid, holder.cid_source);
    if (restored !== "ok") await recordHolderOverwrite();
    await reopenConflict(scoped, conflictId);
    throw new Error(claimed === "taken" ? CID_TAKEN : PERSON_CHANGED);
  }

  await recordHolderOverwrite();
}

/**
 * "Not the same person": records a dismissal for this exact group membership
 * (name_key + members_hash). Idempotent; a changed group has a new hash and
 * shows again.
 */
export async function dismissSameNameGroup(
  clubId: string,
  nameKey: string,
  membersHash: string,
  by: string,
): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  const { error } = await scoped
    .from("person_duplicate_dismissal")
    .upsert(
      { name_key: nameKey, members_hash: membersHash, dismissed_by: by },
      { onConflict: "club_id,name_key,members_hash", ignoreDuplicates: true },
    );
  if (error) throw error;
}
