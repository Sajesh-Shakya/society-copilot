"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  approveChaseEmail,
  rejectChaseEmail,
  approveChaseEmailAndRemember,
  revokeStandingApproval,
} from "@/lib/chase/approval-writer";
import { sendChaseEmail } from "@/lib/chase/send";

// DC-3/DC-4: an admin approves, sends, or rejects a chase_email draft from
// the approval inbox (app/club/[clubSlug]/admin/chase-inbox/page.tsx). The actual writes
// live in lib/chase/approval-writer.ts and lib/chase/send.ts, both plain
// (non-"use server") modules -- every export of a "use server" file is a
// reachable Server Action by reference, so authorization-sensitive logic
// must never be exported from here unguarded. These three wrappers are
// this file's only exports.

export async function approveChase(clubSlug: string, chaseEmailId: string): Promise<{ approved: boolean }> {
  const admin = await requireAdmin(clubSlug);
  return approveChaseEmail(chaseEmailId, admin.clubId, admin.email);
}

export async function sendChase(clubSlug: string, chaseEmailId: string): Promise<{ sent: boolean; reason?: string }> {
  const admin = await requireAdmin(clubSlug);
  return sendChaseEmail(chaseEmailId, admin.clubId);
}

export async function rejectChase(clubSlug: string, chaseEmailId: string, note: string): Promise<{ rejected: boolean }> {
  const admin = await requireAdmin(clubSlug);
  return rejectChaseEmail(chaseEmailId, admin.clubId, note, admin.email);
}

export async function approveChaseAndRemember(clubSlug: string, chaseEmailId: string): Promise<{ approved: boolean; sent?: boolean; reason?: string }> {
  const admin = await requireAdmin(clubSlug);
  return approveChaseEmailAndRemember(chaseEmailId, admin.clubId, admin.email);
}

export async function revokeStandingApprovalAction(clubSlug: string, personId: string): Promise<{ revoked: boolean }> {
  const admin = await requireAdmin(clubSlug);
  return revokeStandingApproval(personId, admin.clubId);
}

export async function setAutoSendPausedAction(clubSlug: string, paused: boolean): Promise<{ ok: true } | { error: string }> {
  const admin = await requireAdmin(clubSlug);
  // club is not a club-scoped table; the id comes from the verified admin.
  const { error } = await createAdminClient().from("club").update({ chase_auto_send_paused: paused }).eq("id", admin.clubId);
  if (error) return { error: error.message };
  return { ok: true };
}
