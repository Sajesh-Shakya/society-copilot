"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

const setPersonExemptSchema = z.object({
  personId: z.string().uuid(),
  exempt: z.boolean(),
  reason: z.string().max(500).optional(),
});

// DC-5: any admin may set or clear a person's exemption; a reason is
// optional. See design.md's "Exemption authority" resolution.
export async function setPersonExempt(
  input: z.infer<typeof setPersonExemptSchema>
): Promise<void> {
  const admin_user = await requireAdmin();
  const parsed = setPersonExemptSchema.parse(input);
  const admin = createAdminClient();

  const { error } = await admin
    .from("person")
    .update({
      is_exempt: parsed.exempt,
      exempt_set_by: parsed.exempt ? admin_user.email : null,
      exempt_set_at: parsed.exempt ? new Date().toISOString() : null,
      exempt_reason: parsed.exempt ? (parsed.reason ?? null) : null,
    })
    .eq("id", parsed.personId);

  if (error) {
    throw new Error(`Failed to update exemption for person ${parsed.personId}: ${error.message}`);
  }
}
