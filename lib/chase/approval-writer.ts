import { z } from "zod";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { sendChaseEmail } from "@/lib/chase/send";
import type { EmailChannelAdapter } from "@/lib/email/types";
import { resendEmailAdapter } from "@/lib/email/resend-adapter";

const rejectChaseEmailSchema = z.object({
  chaseEmailId: z.string().uuid(),
  note: z.string().trim().min(1).max(1000),
  actorEmail: z.string(),
});

// The actual database writes for DC-3 (approve) and the reject/cancel path
// (core/RULES.md §10: every rejected draft preserves reviewer feedback).
// approveChaseEmail also re-approves a 'failed' row -- see
// docs/superpowers/specs/2026-09-23-chase-email-sending-design.md's
// "Failure handling": retry is always this manual re-approval, never
// automatic.
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
  clubId: string,
  actorEmail: string
): Promise<{ approved: boolean }> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("chase_email")
    .update({ status: "approved", approved_by: actorEmail, approved_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .in("status", ["pending_approval", "failed"])
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
  clubId: string,
  note: string,
  actorEmail: string
): Promise<{ rejected: boolean }> {
  const parsed = rejectChaseEmailSchema.parse({ chaseEmailId, note, actorEmail });
  const scoped = createClubScopedClient(clubId);
  // Prefix with who/when rather than adding a new column -- chase_email's
  // own columns are this feature's audit trail (see design.md), and this
  // is the one write path that previously dropped that attribution.
  const attributedNote = `${parsed.actorEmail} @ ${new Date().toISOString()}: ${parsed.note}`;
  const { data, error } = await scoped
    .from("chase_email")
    .update({ status: "cancelled", note: attributedNote })
    .eq("id", parsed.chaseEmailId)
    .in("status", ["pending_approval", "approved", "failed"])
    .select("id");

  if (error) {
    throw new Error(`Failed to reject chase_email ${chaseEmailId}: ${error.message}`);
  }
  return { rejected: (data?.length ?? 0) > 0 };
}

// Standing approval: an admin's per-person "don't ask again". Exempt people
// are refused. Only has effect while CHASE_AUTO_SEND_REPEATS === "true".
export async function grantStandingApproval(
  personId: string,
  clubId: string,
  actorEmail: string
): Promise<{ granted: boolean }> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("person")
    .update({ chase_auto_approved_at: new Date().toISOString(), chase_auto_approved_by: actorEmail })
    .eq("id", personId)
    .eq("is_exempt", false)
    .select("id");
  if (error) throw new Error(`Failed to grant standing approval for person ${personId}: ${error.message}`);
  return { granted: (data?.length ?? 0) > 0 };
}

export async function revokeStandingApproval(personId: string, clubId: string): Promise<{ revoked: boolean }> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("person")
    .update({ chase_auto_approved_at: null, chase_auto_approved_by: null })
    .eq("id", personId)
    .select("id");
  if (error) throw new Error(`Failed to revoke standing approval for person ${personId}: ${error.message}`);
  return { revoked: (data?.length ?? 0) > 0 };
}

// One click: approve, remember the person, and send this email now. The
// admin's click is the human approval; sendChaseEmail still re-checks that the
// person is not exempt and still owes before anything goes out.
export async function approveChaseEmailAndRemember(
  chaseEmailId: string,
  clubId: string,
  actorEmail: string,
  adapter: EmailChannelAdapter = resendEmailAdapter
): Promise<{ approved: boolean; sent?: boolean; reason?: string }> {
  const result = await approveChaseEmail(chaseEmailId, clubId, actorEmail);
  if (!result.approved) return result;
  const scoped = createClubScopedClient(clubId);
  const { data, error } = (await scoped
    .from("chase_email")
    .select("person_id")
    .eq("id", chaseEmailId)
    .maybeSingle()) as unknown as { data: { person_id: string } | null; error: { message: string } | null };
  if (error) throw new Error(`Failed to look up chase_email ${chaseEmailId}: ${error.message}`);
  if (data) await grantStandingApproval(data.person_id, clubId, actorEmail);
  const sendResult = await sendChaseEmail(chaseEmailId, clubId, adapter);
  return { approved: true, ...sendResult };
}
