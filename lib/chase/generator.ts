import { createAdminClient } from "@/lib/supabase/admin";
import { listActiveDebtCycles } from "@/lib/chase/debt-cycles";
import { buildChaseEmailContent } from "@/lib/chase/template";

const CHASE_THRESHOLD_DAYS = Number(process.env.CHASE_THRESHOLD_DAYS ?? 7);
const AUTO_SEND_REPEATS = process.env.CHASE_AUTO_SEND_REPEATS === "true";

function daysBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24);
}

// DC-2/DC-3/DC-4/DC-6: draft the next chase_email for every active debt
// cycle whose cadence has come due. See design.md's "Chase-email cadence"
// and "Repeat auto-send policy" architecture decisions.
export async function generateChaseEmails(): Promise<{ created: number }> {
  const admin = createAdminClient();
  const cycles = await listActiveDebtCycles();
  const now = new Date();
  let created = 0;

  for (const cycle of cycles) {
    const { data: existing, error: existingError } = await admin
      .from("chase_email")
      .select("sequence_number, status, sent_at")
      .eq("person_id", cycle.personId)
      .eq("debt_cycle_started_at", cycle.debtCycleStartedAt)
      .order("sequence_number", { ascending: false })
      .limit(1);

    if (existingError) {
      throw new Error(
        `Failed to look up existing chase emails for person ${cycle.personId}: ${existingError.message}`
      );
    }

    const last = existing?.[0];
    let shouldGenerate = false;
    let nextSequence = 1;

    if (!last) {
      shouldGenerate =
        daysBetween(new Date(cycle.debtCycleStartedAt), now) >= CHASE_THRESHOLD_DAYS;
    } else if (last.status === "sent" && last.sent_at) {
      nextSequence = last.sequence_number + 1;
      shouldGenerate = daysBetween(new Date(last.sent_at), now) >= CHASE_THRESHOLD_DAYS;
    }
    // else: a draft/pending_approval/approved row already exists for this
    // cycle and hasn't been sent yet -- don't pile up another one on top of
    // it. This is the mechanism, not a special case: shouldGenerate simply
    // stays false.

    if (!shouldGenerate) continue;

    const { subject, body } = buildChaseEmailContent({
      fullName: cycle.fullName,
      debtCount: cycle.debtCount,
    });
    const status =
      nextSequence === 1 ? "pending_approval" : AUTO_SEND_REPEATS ? "approved" : "pending_approval";

    const { error: insertError } = await admin.from("chase_email").insert({
      person_id: cycle.personId,
      debt_cycle_started_at: cycle.debtCycleStartedAt,
      sequence_number: nextSequence,
      status,
      subject,
      body,
    });

    if (insertError) {
      // 23503 = foreign_key_violation: the person (or their debt cycle)
      // disappeared between listActiveDebtCycles() and this insert -- e.g.
      // deleted, waived, or exempted concurrently. Skip rather than fail
      // the whole run over one stale cycle.
      if (insertError.code === "23503") continue;
      throw new Error(
        `Failed to create chase_email for person ${cycle.personId}: ${insertError.message}`
      );
    }

    created++;
  }

  return { created };
}
