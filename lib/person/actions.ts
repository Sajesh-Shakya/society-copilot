"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { applyPersonExempt, type SetPersonExemptInput } from "@/lib/person/exempt-writer";

// DC-5: any admin may set or clear a person's exemption; a reason is
// optional. See design.md's "Exemption authority" resolution.
//
// The actual database write lives in lib/person/exempt-writer.ts, a plain
// (non-"use server") module -- every export of a "use server" file is a
// reachable Server Action by reference, so authorization-sensitive logic
// must never be exported from here unguarded. This file's only export is
// this admin-gated wrapper.
export async function setPersonExempt(input: SetPersonExemptInput): Promise<void> {
  const admin_user = await requireAdmin();
  await applyPersonExempt(input, admin_user.email);
}
