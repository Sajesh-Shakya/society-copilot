"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTargets } from "@/lib/dashboard/targets";

export async function updateTargetsAction(
  clubSlug: string,
  input: { signupTarget: number; signupMin: number }
): Promise<{ ok: true } | { error: string }> {
  const admin = await requireAdmin(clubSlug);
  const v = validateTargets(input);
  if ("error" in v) return v;
  // club is not a club-scoped table; the id comes from the verified admin.
  const { error } = await createAdminClient()
    .from("club")
    .update({ signup_target: v.signupTarget, signup_min: v.signupMin })
    .eq("id", admin.clubId);
  if (error) return { error: error.message };
  return { ok: true };
}
