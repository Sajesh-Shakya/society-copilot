import type { createClubScopedClient } from "@/lib/supabase/club-scoped";
import type { CidSource } from "@/lib/identity/cid-rule";

export type ScopedClient = ReturnType<typeof createClubScopedClient>;

export type IdentityOutcome = "overwritten" | "flagged" | "ignored";

export interface ConflictRow {
  personId: string;
  existingCid: string | null;
  existingSource: CidSource | null;
  incomingCid: string;
  incomingSource: CidSource;
  otherPersonId?: string | null;
  outcome: IdentityOutcome;
}

/** Postgres unique_violation. */
export const UNIQUE_VIOLATION = "23505";

/**
 * Logs one CID conflict. Flagged rows open for admin review; overwritten and
 * ignored rows are informational. Flagged and ignored share a dedup key
 * (person_identity_conflict_dedup_idx) on (person, incoming_cid,
 * incoming_source), so on a repeat claim:
 *  - an `ignored` request is a no-op;
 *  - a `flagged` request promotes an earlier `ignored` row to an open flag
 *    (so an old ignore cannot hide a real conflict), but leaves an existing
 *    flag untouched in any status (a dismissed flag stays dismissed).
 */
export async function recordConflict(scoped: ScopedClient, row: ConflictRow): Promise<void> {
  const { error } = await scoped.from("person_identity_conflict").insert({
    person_id: row.personId,
    existing_cid: row.existingCid,
    existing_source: row.existingSource,
    incoming_cid: row.incomingCid,
    incoming_source: row.incomingSource,
    other_person_id: row.otherPersonId ?? null,
    outcome: row.outcome,
    status: row.outcome === "flagged" ? "open" : "resolved",
  });
  if (!error) return;
  if (error.code !== UNIQUE_VIOLATION || row.outcome === "overwritten") throw error;
  if (row.outcome === "ignored") return;

  const { data, error: findError } = await scoped
    .from("person_identity_conflict")
    .select("id, outcome")
    .eq("person_id", row.personId)
    .eq("incoming_cid", row.incomingCid)
    .eq("incoming_source", row.incomingSource)
    .in("outcome", ["flagged", "ignored"])
    .limit(1);
  if (findError) throw findError;
  const existing = ((data ?? []) as unknown as Array<{ id: string; outcome: IdentityOutcome }>)[0];
  if (!existing || existing.outcome !== "ignored") return;

  const { error: promoteError } = await scoped
    .from("person_identity_conflict")
    .update({
      outcome: "flagged",
      status: "open",
      existing_cid: row.existingCid,
      existing_source: row.existingSource,
      other_person_id: row.otherPersonId ?? null,
      resolved_at: null,
      resolved_by: null,
    })
    .eq("id", existing.id)
    .eq("outcome", "ignored");
  if (promoteError) throw promoteError;
}
