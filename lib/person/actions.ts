"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

const setPersonExemptSchema = z.object({
  personId: z.string().uuid(),
  exempt: z.boolean(),
  reason: z.string().max(500).optional(),
});

export type SetPersonExemptInput = z.infer<typeof setPersonExemptSchema>;

// DC-5: any admin may set or clear a person's exemption; a reason is
// optional. See design.md's "Exemption authority" resolution.
//
// Split into an admin-gated wrapper and a plain update function so
// integration tests can exercise the actual database write without a live
// Next.js request context (requireAdmin() calls next/headers' cookies(),
// which throws outside one). setPersonExempt below is still the only
// production entry point and still requires requireAdmin() to succeed
// first -- this split only makes the write itself testable in isolation.
export async function applyPersonExempt(
  input: SetPersonExemptInput,
  actorEmail: string
): Promise<void> {
  const parsed = setPersonExemptSchema.parse(input);
  const admin = createAdminClient();

  const { error } = await admin
    .from("person")
    .update({
      is_exempt: parsed.exempt,
      exempt_set_by: parsed.exempt ? actorEmail : null,
      exempt_set_at: parsed.exempt ? new Date().toISOString() : null,
      exempt_reason: parsed.exempt ? (parsed.reason ?? null) : null,
    })
    .eq("id", parsed.personId);

  if (error) {
    throw new Error(`Failed to update exemption for person ${parsed.personId}: ${error.message}`);
  }
}

export async function setPersonExempt(input: SetPersonExemptInput): Promise<void> {
  const admin_user = await requireAdmin();
  await applyPersonExempt(input, admin_user.email);
}
