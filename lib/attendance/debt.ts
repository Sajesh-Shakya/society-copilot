import { createClubScopedClient } from "@/lib/supabase/club-scoped";

// Unpaid attended sessions per person, read live from active_debt_cycle
// (derived from attendance_record + purchases on every read, never stored).
// People with no debt, and exempt people, are absent from the result.
export async function getRosterDebts(clubId: string, personIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (personIds.length === 0) return out;
  const scoped = createClubScopedClient(clubId);
  for (let i = 0; i < personIds.length; i += 200) {
    const { data, error } = await scoped
      .from("active_debt_cycle")
      .select("person_id, debt_count")
      .in("person_id", personIds.slice(i, i + 200));
    if (error) throw new Error(`Failed to load roster debts: ${error.message}`);
    for (const r of (data ?? []) as unknown as { person_id: string; debt_count: number | string }[]) {
      out[r.person_id] = Number(r.debt_count);
    }
  }
  return out;
}
