import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { createAdminClient } from "@/lib/supabase/admin";
import { STANDING_CANCEL_NOTE } from "@/lib/chase/standing";
import { getOutstandingDebt } from "@/lib/debt/calculator";
import type { EmailChannelAdapter } from "@/lib/email/types";
import { resendEmailAdapter } from "@/lib/email/resend-adapter";

// Session addition (not in the original tasks.md text, requested directly
// this session): re-check live debt immediately before sending. A chase
// email can sit approved for days; if the person paid in the meantime, this
// cancels the send instead of chasing a cleared debt. See design.md's
// "Pre-send debt recheck" architecture decision.
//
// `adapter` defaults to the real Resend adapter but is overridable so
// tests can inject a fake -- see docs/superpowers/specs/2026-09-23-
// chase-email-sending-design.md.
export async function sendChaseEmail(
  chaseEmailId: string,
  clubId: string,
  adapter: EmailChannelAdapter = resendEmailAdapter
): Promise<{ sent: boolean; reason?: string }> {
  const scoped = createClubScopedClient(clubId);

  const { data: row, error: fetchError } = (await scoped
    .from("chase_email")
    .select("id, person_id, status, subject, body")
    .eq("id", chaseEmailId)
    .maybeSingle()) as unknown as {
    data: { id: string; person_id: string; status: string; subject: string; body: string } | null;
    error: { message: string } | null;
  };

  if (fetchError) {
    throw new Error(`Failed to fetch chase_email ${chaseEmailId}: ${fetchError.message}`);
  }
  if (!row) {
    throw new Error(`chase_email ${chaseEmailId} does not belong to this club.`);
  }
  if (row.status !== "approved") {
    throw new Error(
      `chase_email ${chaseEmailId} is not approved (status: ${row.status}) -- refusing to send`
    );
  }

  const { data: person, error: personError } = (await scoped
    .from("person")
    .select("is_exempt, email")
    .eq("id", row.person_id)
    .single()) as unknown as {
    data: { is_exempt: boolean; email: string };
    error: { message: string } | null;
  };
  if (personError) {
    throw new Error(`Failed to fetch person ${row.person_id}: ${personError.message}`);
  }

  if (person.is_exempt) {
    const { error: cancelError } = await scoped
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
    const { error: cancelError } = await scoped
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

  // Atomic claim: flips this row from 'approved' to 'sending' before any
  // Resend call is made. If the cron and a manual "Send" click race on the
  // same row, only one caller's conditional update affects a row -- the
  // other affects zero rows and bails out as 'stale'. See design.md's
  // "Atomic claim before sending" decision.
  const { data: claimedRows, error: claimError } = await scoped
    .from("chase_email")
    .update({ status: "sending" })
    .eq("id", chaseEmailId)
    .eq("status", "approved")
    .select("id");
  if (claimError) {
    throw new Error(`Failed to claim chase_email ${chaseEmailId} for sending: ${claimError.message}`);
  }
  if ((claimedRows?.length ?? 0) === 0) {
    return { sent: false, reason: "stale" };
  }

  try {
    // idempotencyKey = this row's id, reused across any retry attempt for
    // the same row. Resend deduplicates by this key for up to 24 hours
    // after the first attempt -- if our own status write fails and a human
    // retries within that window, no real duplicate email is sent; a retry
    // after 24 hours has no such protection. See design.md's "Idempotency
    // key on the Resend call" decision.
    const { providerMessageId } = await adapter.send({
      to: person.email,
      subject: row.subject,
      body: row.body,
      idempotencyKey: chaseEmailId,
    });

    const { error: sendError } = await scoped
      .from("chase_email")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: providerMessageId,
      })
      .eq("id", chaseEmailId);
    if (sendError) {
      throw new Error(`Failed to record sent chase_email ${chaseEmailId}: ${sendError.message}`);
    }
    return { sent: true };
  } catch (sendAttemptError) {
    // Covers both an adapter.send() rejection and a failed status write
    // after a successful send -- either way, a human needs to see this
    // and decide whether to retry (never automatic; see "Failure
    // handling" in the design doc). A retry reuses the same
    // idempotencyKey above, so Resend dedupes it against the first
    // attempt as long as the retry happens within 24 hours; past that
    // window Resend no longer recognizes the key and a retry could send
    // a real duplicate if the first attempt actually went out.
    const message =
      sendAttemptError instanceof Error ? sendAttemptError.message : String(sendAttemptError);
    const { error: failError } = await scoped
      .from("chase_email")
      .update({ status: "failed", note: message.slice(0, 1000) })
      .eq("id", chaseEmailId);
    if (failError) {
      throw new Error(`Failed to record failed chase_email ${chaseEmailId}: ${failError.message}`);
    }
    return { sent: false, reason: "send_failed" };
  }
}

// DC-4's auto-send path. Eligible: approved rows that are repeat reminders
// (sequence_number > 1, pre-approved under CHASE_AUTO_SEND_REPEATS) or were
// created under a person's standing approval (auto_approved = true).
// Gates, in order: global flag; club pause (rows stay approved so
// un-pausing resumes); per-run cap CHASE_AUTO_SEND_MAX_PER_RUN (default 50).
// Standing-approval rows re-check the person at send time.
function maxPerRun(): number {
  const n = Number.parseInt(process.env.CHASE_AUTO_SEND_MAX_PER_RUN ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export async function processAutoSends(
  clubId: string,
  adapter: EmailChannelAdapter = resendEmailAdapter
): Promise<{
  sent: number;
  cancelled: number;
  failed: number;
  skipped: number;
}> {
  const none = { sent: 0, cancelled: 0, failed: 0, skipped: 0 };
  if (process.env.CHASE_AUTO_SEND_REPEATS !== "true") return none;

  const { data: club, error: clubError } = await createAdminClient()
    .from("club")
    .select("chase_auto_send_paused")
    .eq("id", clubId)
    .single();
  if (clubError) throw new Error(`Failed to read club pause state: ${clubError.message}`);
  if (club.chase_auto_send_paused) return none;

  const scoped = createClubScopedClient(clubId);
  const eligible = "sequence_number.gt.1,auto_approved.eq.true";
  const cap = maxPerRun();
  const { data: rows, error } = (await scoped
    .from("chase_email")
    .select("id, person_id, auto_approved")
    .eq("status", "approved")
    .or(eligible)
    .order("created_at", { ascending: true })
    .limit(cap)) as unknown as {
    data: { id: string; person_id: string; auto_approved: boolean }[] | null;
    error: { message: string } | null;
  };
  if (error) {
    throw new Error(`Failed to list auto-sendable chase emails: ${error.message}`);
  }

  const { count: totalEligible, error: countError } = await scoped
    .from("chase_email")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved")
    .or(eligible);
  if (countError) throw new Error(`Failed to count auto-sendable chase emails: ${countError.message}`);

  const rowsToSend = rows ?? [];
  let sent = 0;
  let cancelled = 0;
  let failed = 0;
  const skipped = Math.max(0, (totalEligible ?? rowsToSend.length) - rowsToSend.length);

  for (let i = 0; i < rowsToSend.length; i++) {
    const row = rowsToSend[i];

    if (row.auto_approved) {
      const { data: person, error: personError } = (await scoped
        .from("person")
        .select("is_exempt, chase_auto_approved_at")
        .eq("id", row.person_id)
        .maybeSingle()) as unknown as {
        data: { is_exempt: boolean; chase_auto_approved_at: string | null } | null;
        error: { message: string } | null;
      };
      if (personError) throw new Error(`Failed to re-check person ${row.person_id}: ${personError.message}`);
      if (!person || person.is_exempt || person.chase_auto_approved_at === null) {
        const { error: cancelError } = await scoped
          .from("chase_email")
          .update({
            status: "cancelled",
            note: STANDING_CANCEL_NOTE,
          })
          .eq("id", row.id)
          .eq("status", "approved");
        if (cancelError) throw new Error(`Failed to cancel chase_email ${row.id}: ${cancelError.message}`);
        cancelled++;
        continue;
      }
    }

    const result = await sendChaseEmail(row.id, clubId, adapter);
    if (result.sent) sent++;
    else if (result.reason === "send_failed") failed++;
    else cancelled++;

    // Small delay between sends to stay comfortably under Resend's
    // per-second rate limit -- cheap at this scale. See design.md's
    // "Rate limiting" section.
    if (i < rowsToSend.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return { sent, cancelled, failed, skipped };
}
