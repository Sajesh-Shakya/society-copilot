import { createAdminClient } from "@/lib/supabase/admin";

export type ActiveDebtCycle = {
  personId: string;
  fullName: string;
  email: string;
  debtCycleStartedAt: string;
  debtCount: number;
};

// DC-2/DC-5/DC-6: every non-exempt person currently in debt, derived live
// from public.active_debt_cycle -- see
// supabase/migrations/20260921110000_add_active_debt_cycle_view.sql.
export async function listActiveDebtCycles(): Promise<ActiveDebtCycle[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("active_debt_cycle")
    .select("person_id, full_name, email, debt_cycle_started_at, debt_count");

  if (error) {
    throw new Error(`Failed to list active debt cycles: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    personId: row.person_id,
    fullName: row.full_name,
    email: row.email,
    debtCycleStartedAt: row.debt_cycle_started_at,
    debtCount: Number(row.debt_count),
  }));
}
