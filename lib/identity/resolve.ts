/**
 * The writers behind the people-review Server Actions (lib/identity/actions.ts
 * calls requireAdmin() first, then these). Every read and write goes through
 * the club-scoped client, so an id from another club is "not found".
 *
 * Failure safety: a write can fail by a guard miss (the row changed) or by a
 * thrown error (network, timeout) that may or may not have landed. Every
 * path below ends either fully applied, fully rolled back (conflict open
 * again, no stray audit row), or, if a rollback itself fails, with the
 * holder's change recorded and a PARTIAL_CID_MOVE error. Secondary failures
 * during rollback are logged and never replace the original error.
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
export const PARTIAL_CID_MOVE = "The CID move was only partly applied and needs a look";

type ConflictForResolve = {
  id: string;
  person_id: string;
  existing_cid: string | null;
  existing_source: CidSource | null;
  incoming_cid: string;
  incoming_source: CidSource;
  other_person_id: string | null;
  outcome: string;
  status: string;
};

type PersonCid = { id: string; cid: string | null; cid_source: CidSource | null };

type HookPoint = "afterVacate" | "beforeRestore" | "beforeIncomingWrite";
let testHook: ((point: HookPoint) => Promise<void>) | null = null;

/** No-op in production; tests inject failures at named points via __testing.setHook. */
async function hook(point: HookPoint): Promise<void> {
  if (testHook) await testHook(point);
}

/** Adds `col = value` (or `col IS NULL`) so an update only lands on the state that was read. */
function guard<Q extends { eq(c: string, v: string): Q; is(c: string, v: null): Q }>(
  q: Q,
  col: string,
  value: string | null,
): Q {
  return value === null ? q.is(col, null) : q.eq(col, value);
}

/** Runs a rollback step; a failure is logged and swallowed so it never masks the original error. */
async function bestEffort(label: string, step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (err) {
    console.error(`identity resolve: ${label} failed during rollback`, err);
    return false;
  }
}

/** Loads an open flagged conflict in this club; throws CONFLICT_NOT_FOUND / CONFLICT_NOT_OPEN. */
async function loadOpenConflict(scoped: ScopedClient, conflictId: string): Promise<ConflictForResolve> {
  const { data, error } = await scoped
    .from("person_identity_conflict")
    .select("id, person_id, existing_cid, existing_source, incoming_cid, incoming_source, other_person_id, outcome, status")
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

/**
 * The person must still hold the CID the conflict was recorded against
 * (otherwise the admin is deciding on stale information). With no CID on
 * either side the sources are irrelevant.
 */
function assertUnchangedSinceFlag(conflict: ConflictForResolve, person: PersonCid): void {
  if (conflict.existing_cid === null && person.cid === null) return;
  if (conflict.existing_cid !== person.cid || conflict.existing_source !== person.cid_source) {
    throw new Error(PERSON_CHANGED);
  }
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
  at: string = new Date().toISOString(),
): Promise<void> {
  const { data, error } = await scoped
    .from("person_identity_conflict")
    .update({ status, resolved_by: by, resolved_at: at })
    .eq("id", conflictId)
    .eq("outcome", "flagged")
    .eq("status", "open")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error(CONFLICT_NOT_OPEN);
}

/**
 * Undoes this call's closeConflict after a later step failed, so the conflict
 * stays actionable. Guarded on the row still being exactly what this call
 * wrote (resolved, by this admin, at this timestamp), so a conflict someone
 * else has since closed or changed is never reopened.
 */
async function reopenConflict(scoped: ScopedClient, conflictId: string, by: string, at: string): Promise<void> {
  const { error } = await scoped
    .from("person_identity_conflict")
    .update({ status: "open", resolved_by: null, resolved_at: null })
    .eq("id", conflictId)
    .eq("outcome", "flagged")
    .eq("status", "resolved")
    .eq("resolved_by", by)
    .eq("resolved_at", at);
  if (error) throw error;
}

/**
 * Closes the conflict as `resolved` and runs `apply`; if apply fails in any
 * way the conflict is reopened (best effort) and the original error re-thrown.
 */
async function withConflictClaimed(
  scoped: ScopedClient,
  conflictId: string,
  by: string,
  apply: () => Promise<void>,
): Promise<void> {
  const at = new Date().toISOString();
  try {
    await closeConflict(scoped, conflictId, "resolved", by, at);
  } catch (err) {
    // A thrown (not guard-miss) close may have landed: make sure it is open.
    if (!(err instanceof Error && err.message === CONFLICT_NOT_OPEN)) {
      await bestEffort("reopen conflict", () => reopenConflict(scoped, conflictId, by, at));
    }
    throw err;
  }
  try {
    await apply();
  } catch (err) {
    await bestEffort("reopen conflict", () => reopenConflict(scoped, conflictId, by, at));
    throw err;
  }
}

/**
 * Guarded CID write on a person: lands only if their cid/cid_source are still
 * what was read. Returns "ok", "changed" (guard missed) or "taken" (unique
 * violation: another person holds the CID). Other errors throw.
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
 * "Use incoming": only when the person is unchanged since the flag and the
 * incoming CID is free club-wide. The conflict is claimed (open -> resolved,
 * guarded) first; any failure of the person write reopens it.
 */
export async function useIncoming(clubId: string, conflictId: string, by: string): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  const conflict = await loadOpenConflict(scoped, conflictId);
  const person = await loadPerson(scoped, conflict.person_id);
  assertUnchangedSinceFlag(conflict, person);
  if (await findHolder(scoped, person.id, conflict.incoming_cid)) throw new Error(CID_TAKEN);

  await withConflictClaimed(scoped, conflictId, by, async () => {
    await hook("beforeIncomingWrite");
    const result = await writeCid(scoped, person, conflict.incoming_cid, conflict.incoming_source);
    if (result !== "ok") throw new Error(result === "taken" ? CID_TAKEN : PERSON_CHANGED);
  });
}

/**
 * "Take this CID from the other person": only when the person is unchanged
 * since the flag, the conflict names a holder who still holds the incoming
 * CID, and the incoming source outranks the holder's cid_source (a null
 * source counts as sso, as in the rule).
 *
 * Order:
 *  1. claim the conflict (open -> resolved, guarded) -- stops a second admin;
 *  2. insert the holder's `overwritten` row (resolved) BEFORE touching the
 *     holder, so their CID is never cleared without a record;
 *  3. vacate: clear the holder's cid/cid_source (guarded);
 *  4. claim: set the CID on the person (guarded).
 * If 2 fails, the conflict is reopened. If 3 misses its guard nothing was
 * cleared: the provisional row is deleted and the conflict reopened. If 3
 * throws (it may have landed) or 4 fails in any way, the holder's CID is restored
 * (guarded on it being empty), then the provisional row is deleted and the
 * conflict reopened, and the original error re-thrown. If the holder cannot
 * be shown to hold their CID again, the row is kept (with other_person_id
 * cleared unless the person actually holds the CID), the conflict reopened,
 * and PARTIAL_CID_MOVE thrown.
 */
export async function takeCidFromHolder(clubId: string, conflictId: string, by: string): Promise<void> {
  const scoped = createClubScopedClient(clubId);
  const conflict = await loadOpenConflict(scoped, conflictId);
  if (!conflict.other_person_id) throw new Error(NO_OTHER_PERSON);
  const person = await loadPerson(scoped, conflict.person_id);
  assertUnchangedSinceFlag(conflict, person);
  const holder = await loadPerson(scoped, conflict.other_person_id);
  if (holder.cid !== conflict.incoming_cid) throw new Error(HOLDER_CHANGED);
  if (!outranks(conflict.incoming_source, holder.cid_source ?? "sso")) throw new Error(HOLDER_NOT_OUTRANKED);
  const cid = conflict.incoming_cid;

  await withConflictClaimed(scoped, conflictId, by, async () => {
    const now = new Date().toISOString();
    const { data: rowData, error: rowError } = await scoped
      .from("person_identity_conflict")
      .insert({
        person_id: holder.id,
        existing_cid: holder.cid,
        existing_source: holder.cid_source,
        incoming_cid: cid,
        incoming_source: conflict.incoming_source,
        other_person_id: person.id,
        outcome: "overwritten",
        status: "resolved",
        resolved_by: by,
        resolved_at: now,
      })
      .select("id")
      .single();
    if (rowError) throw rowError;
    const provisionalId = (rowData as unknown as { id: string }).id;

    // False only once the vacate is known not to have landed (guard miss).
    let mayHaveVacated = true;
    try {
      const vacated = await writeCid(scoped, holder, null, null);
      if (vacated !== "ok") {
        mayHaveVacated = false;
        throw new Error(HOLDER_CHANGED);
      }
      await hook("afterVacate");
      const claimed = await writeCid(scoped, person, cid, conflict.incoming_source);
      if (claimed !== "ok") throw new Error(claimed === "taken" ? CID_TAKEN : PERSON_CHANGED);
    } catch (err) {
      if (!mayHaveVacated || (await restoreHolder(scoped, holder))) {
        const deleted = await bestEffort("delete provisional overwritten row", async () => {
          const { error } = await scoped.from("person_identity_conflict").delete().eq("id", provisionalId);
          if (error) throw error;
        });
        // A kept extra audit row is safer than a missing one; still surface the original error.
        if (!deleted) console.error("identity resolve: kept provisional overwritten row", provisionalId);
        throw err;
      }
      // The holder's CID is (or may be) gone: keep the record, fix its attribution.
      await bestEffort("fix overwritten row attribution", async () => {
        const current = await loadPerson(scoped, person.id);
        if (current.cid === cid) return;
        const { error } = await scoped
          .from("person_identity_conflict")
          .update({ other_person_id: null })
          .eq("id", provisionalId);
        if (error) throw error;
      });
      console.error("identity resolve: partial CID move", { conflictId, holderId: holder.id }, err);
      throw new Error(PARTIAL_CID_MOVE, { cause: err });
    }
  });
}

/**
 * Puts the holder's CID back after a failed take. True when the holder is
 * known to hold their CID again (restored now, or never actually cleared).
 */
async function restoreHolder(scoped: ScopedClient, holder: PersonCid): Promise<boolean> {
  try {
    await hook("beforeRestore");
    const restored = await writeCid(scoped, { id: holder.id, cid: null, cid_source: null }, holder.cid, holder.cid_source);
    if (restored === "ok") return true;
    if (restored === "taken") return false;
    // Guard missed: the holder isn't empty -- fine if they still have their CID.
    const now = await loadPerson(scoped, holder.id);
    return now.cid === holder.cid;
  } catch (err) {
    console.error("identity resolve: restoring the holder's CID failed", err);
    return false;
  }
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

/** Test-only seam: inject a failure at a named point. Unset (null) in production. */
export const __testing = {
  setHook(fn: ((point: HookPoint) => Promise<void>) | null): void {
    testHook = fn;
  },
};
