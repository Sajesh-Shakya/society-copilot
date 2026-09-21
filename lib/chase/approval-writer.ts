import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

const rejectChaseEmailSchema = z.object({
  chaseEmailId: z.string().uuid(),
  note: z.string().min(1).max(1000),
  actorEmail: z.string(),
});

// The actual database writes for DC-3 (approve) and the reject/cancel path
// (core/RULES.md §10: every rejected draft preserves reviewer feedback).
// Deliberately NOT in a "use server" file: every export of a "use server"
// module is a reachable Server Action by reference, regardless of whether
// anything currently imports it, so authorization-sensitive logic must
// never live there unguarded. This plain module is imported by both the
// admin-gated Server Actions (lib/chase/actions.ts) and integration tests.
//
// Both writes are conditional on the row's current status: acting on an
// already-actioned row (approved twice, rejected after being sent, etc.)
// is a no-op, not an error -- the same convention lib/chase/send.ts uses
// for its own guarded updates.

export async function approveChaseEmail(
  chaseEmailId: string,
  actorEmail: string
): Promise<{ approved: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("chase_email")
    .update({ status: "approved", approved_by: actorEmail, approved_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .eq("status", "pending_approval")
    .select("id");

  if (error) {
    throw new Error(`Failed to approve chase_email ${chaseEmailId}: ${error.message}`);
  }
  return { approved: (data?.length ?? 0) > 0 };
}

// Known limitation (Phase 6 final-review TRACKED GAP, see design.md): once
// cancelled here, this cycle has no defined path back to being chased
// again if the person's debt persists or recurs -- not addressed by this
// function.
export async function rejectChaseEmail(
  chaseEmailId: string,
  note: string,
  actorEmail: string
): Promise<{ rejected: boolean }> {
  const parsed = rejectChaseEmailSchema.parse({ chaseEmailId, note, actorEmail });
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("chase_email")
    .update({ status: "cancelled", note: parsed.note })
    .eq("id", parsed.chaseEmailId)
    .in("status", ["pending_approval", "approved"])
    .select("id");

  if (error) {
    throw new Error(`Failed to reject chase_email ${chaseEmailId}: ${error.message}`);
  }
  return { rejected: (data?.length ?? 0) > 0 };
}
