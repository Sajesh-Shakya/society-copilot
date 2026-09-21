import { createAdminClient } from "@/lib/supabase/admin";

// DC-1: a person's current outstanding (unpaid) debt, derived live from
// attendance_record via the outstanding_attendance view -- see
// supabase/migrations/20260920120000_add_debt_calculation_functions.sql.
// Never stored as a mutable field.
export async function getOutstandingDebt(personId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("person_outstanding_debt", {
    target_person_id: personId,
  });

  if (error) {
    throw new Error(
      `Failed to compute outstanding debt for person ${personId}: ${error.message}`
    );
  }

  return data ?? 0;
}
