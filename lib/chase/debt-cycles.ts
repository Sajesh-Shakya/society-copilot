import { createClubScopedClient } from "@/lib/supabase/club-scoped";

export type ActiveDebtCycle = {
  personId: string;
  fullName: string;
  email: string;
  debtCycleStartedAt: string;
  debtCount: number;
  chaseAutoApprovedAt: string | null;
  chaseAutoApprovedBy: string | null;
};

// DC-2/DC-5/DC-6: every non-exempt person currently in debt, derived live
// from public.active_debt_cycle -- see
// supabase/migrations/20260921110000_add_active_debt_cycle_view.sql.
export async function listActiveDebtCycles(clubId: string): Promise<ActiveDebtCycle[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("active_debt_cycle")
    .select("person_id, full_name, email, debt_cycle_started_at, debt_count");

  if (error) {
    throw new Error(`Failed to list active debt cycles: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as {
    person_id: string;
    full_name: string;
    email: string;
    debt_cycle_started_at: string;
    debt_count: number | string;
  }[];

  // The view doesn't carry standing-approval columns: fetch them from person
  // in chunks (URL length limits on .in()).
  const approvals = new Map<string, { at: string | null; by: string | null }>();
  const ids = rows.map((r) => r.person_id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: people, error: peopleError } = await scoped
      .from("person")
      .select("id, chase_auto_approved_at, chase_auto_approved_by")
      .in("id", ids.slice(i, i + 200));
    if (peopleError) {
      throw new Error(`Failed to load standing approvals: ${peopleError.message}`);
    }
    for (const p of (people ?? []) as unknown as {
      id: string;
      chase_auto_approved_at: string | null;
      chase_auto_approved_by: string | null;
    }[]) {
      approvals.set(p.id, { at: p.chase_auto_approved_at, by: p.chase_auto_approved_by });
    }
  }

  return rows.map((row) => ({
    personId: row.person_id,
    fullName: row.full_name,
    email: row.email,
    debtCycleStartedAt: row.debt_cycle_started_at,
    debtCount: Number(row.debt_count),
    chaseAutoApprovedAt: approvals.get(row.person_id)?.at ?? null,
    chaseAutoApprovedBy: approvals.get(row.person_id)?.by ?? null,
  }));
}
