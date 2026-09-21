import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

const setPersonExemptSchema = z.object({
  personId: z.string().uuid(),
  exempt: z.boolean(),
  reason: z.string().max(500).optional(),
});

export type SetPersonExemptInput = z.infer<typeof setPersonExemptSchema>;

// The actual database write for DC-5 (any admin may set/clear
// person.is_exempt, reason optional). Deliberately NOT in a "use server"
// file: every export of a "use server" module is a reachable Server Action
// by reference, regardless of whether anything currently imports it, so
// authorization-sensitive logic must never live there unguarded. This
// plain module can be safely imported by both the admin-gated Server
// Action (lib/person/actions.ts) and integration tests, with no risk of
// becoming a client-callable endpoint.
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
