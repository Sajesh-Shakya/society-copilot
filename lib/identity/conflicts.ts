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

const UNIQUE_VIOLATION = "23505";

/**
 * Logs one CID conflict. Flagged rows open for admin review; overwritten and
 * ignored rows are informational. Flagged and ignored share a dedup key
 * (person_identity_conflict_dedup_idx), so a repeat of the same incoming claim
 * is a no-op rather than an error.
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
  if (error.code === UNIQUE_VIOLATION && row.outcome !== "overwritten") return;
  throw error;
}
