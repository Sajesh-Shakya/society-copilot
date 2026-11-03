import { createClubScopedClient } from "@/lib/supabase/club-scoped";

// Backs the failed-send badge on /sessions (see design.md's "Failure
// visibility" decision) -- an admin lands there first and should see a
// failure without having to proactively open the chase inbox.
export async function countFailedChaseEmails(clubId: string): Promise<number> {
  const scoped = createClubScopedClient(clubId);
  const { count, error } = await scoped
    .from("chase_email")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed");

  if (error) {
    throw new Error(`Failed to count failed chase emails: ${error.message}`);
  }
  return count ?? 0;
}
