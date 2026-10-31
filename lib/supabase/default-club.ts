import type { SupabaseClient } from "@supabase/supabase-js";

// Emergency bridge. The multi-tenancy foundation migrations made club_id
// NOT NULL on every club-scoped table, but no application code resolves a
// real per-request club_id yet -- that's a later plan's job (routing +
// requireAdmin() becoming club-aware). Every insert that had no club
// concept at all now needs *some* value, and since the only real data
// today is the Judo club, resolving it here keeps production working.
// Delete every call site that uses this once a real clubId is threaded
// through from the request instead.
let cachedJudoClubId: string | null = null;

export async function getDefaultClubId(admin: SupabaseClient): Promise<string> {
  if (cachedJudoClubId) return cachedJudoClubId;
  const { data, error } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (error) throw error;
  const clubId: string = data.id;
  cachedJudoClubId = clubId;
  return clubId;
}
