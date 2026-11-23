import { createAdminClient } from "@/lib/supabase/admin";
import { reapplyWaiversForPerson } from "@/lib/purchase/interface";

// Merges duplicate people into one kept person, atomically in Postgres
// (merge_people): attendance, purchases and chase emails move to the kept
// person, and a snapshot of each removed person goes to person_merge_log.
// Plain module (not "use server"); the admin-gated wrapper is in
// lib/identity/actions.ts.
export async function mergePeople(
  clubId: string,
  keepPersonId: string,
  mergePersonIds: string[],
  actorEmail: string,
): Promise<{ merged: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("merge_people", {
    target_club_id: clubId,
    keep_person_id: keepPersonId,
    merge_person_ids: mergePersonIds,
    actor: actorEmail,
  });
  if (error) throw new Error(`Merge failed: ${error.message}`);
  // Combined records may leave a purchase with spare capacity (or new debt).
  await reapplyWaiversForPerson(keepPersonId);
  return { merged: Number((data as { merged: number }).merged) };
}
