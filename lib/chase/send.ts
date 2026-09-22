import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingDebt } from "@/lib/debt/calculator";

// Session addition (not in the original tasks.md text, requested directly
// this session): re-check live debt immediately before sending. A chase
// email can sit approved for days; if the person paid in the meantime, this
// cancels the send instead of chasing a cleared debt. See design.md's
// "Pre-send debt recheck" architecture decision.
export async function sendChaseEmail(
  chaseEmailId: string
): Promise<{ sent: boolean; reason?: string }> {
  const admin = createAdminClient();

  const { data: row, error: fetchError } = await admin
    .from("chase_email")
    .select("id, person_id, status")
    .eq("id", chaseEmailId)
    .single();

  if (fetchError) {
    throw new Error(`Failed to fetch chase_email ${chaseEmailId}: ${fetchError.message}`);
  }
  if (row.status !== "approved") {
    throw new Error(
      `chase_email ${chaseEmailId} is not approved (status: ${row.status}) -- refusing to send`
    );
  }

  const { data: person, error: personError } = await admin
    .from("person")
    .select("is_exempt")
    .eq("id", row.person_id)
    .single();
  if (personError) {
    throw new Error(`Failed to fetch person ${row.person_id}: ${personError.message}`);
  }

  if (person.is_exempt) {
    const { error: cancelError } = await admin
      .from("chase_email")
      .update({
        status: "cancelled",
        note: "Auto-cancelled: person was exempted before send.",
      })
      .eq("id", chaseEmailId)
      .eq("status", "approved");
    if (cancelError) {
      throw new Error(`Failed to cancel chase_email ${chaseEmailId}: ${cancelError.message}`);
    }
    return { sent: false, reason: "exempt" };
  }

  const debt = await getOutstandingDebt(row.person_id);

  if (debt <= 0) {
    const { error: cancelError } = await admin
      .from("chase_email")
      .update({
        status: "cancelled",
        note: "Auto-cancelled: debt was already cleared before send.",
      })
      .eq("id", chaseEmailId)
      .eq("status", "approved");
    if (cancelError) {
      throw new Error(`Failed to cancel chase_email ${chaseEmailId}: ${cancelError.message}`);
    }
    return { sent: false, reason: "debt_cleared" };
  }

  const { data: sentRows, error: sendError } = await admin
    .from("chase_email")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", chaseEmailId)
    .eq("status", "approved")
    .select("id");
  if (sendError) {
    throw new Error(`Failed to send chase_email ${chaseEmailId}: ${sendError.message}`);
  }
  if ((sentRows?.length ?? 0) === 0) {
    return { sent: false, reason: "stale" };
  }

  return { sent: true };
}

// DC-4's auto-send path: every repeat reminder (sequence_number > 1) that
// generateChaseEmails() pre-approved under CHASE_AUTO_SEND_REPEATS. Never
// touches sequence_number = 1 rows -- those always require manual approval
// (DC-3) and reach `approved` only through a future Phase 7 admin action.
export async function processAutoSends(): Promise<{ sent: number; cancelled: number }> {
  if (process.env.CHASE_AUTO_SEND_REPEATS !== "true") {
    return { sent: 0, cancelled: 0 };
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("chase_email")
    .select("id")
    .eq("status", "approved")
    .gt("sequence_number", 1);

  if (error) {
    throw new Error(`Failed to list auto-sendable chase emails: ${error.message}`);
  }

  let sent = 0;
  let cancelled = 0;
  for (const row of rows ?? []) {
    const result = await sendChaseEmail(row.id);
    if (result.sent) sent++;
    else cancelled++;
  }

  return { sent, cancelled };
}
