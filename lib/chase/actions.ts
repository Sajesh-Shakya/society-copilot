"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { approveChaseEmail, rejectChaseEmail } from "@/lib/chase/approval-writer";
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
