import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export class UnauthorizedError extends Error {}

/**
 * The actual enforcement point for admin-only Server Actions and pages.
 * Re-checks admin_allowlist on every call (not just at login) so removing
 * someone from the allowlist revokes access immediately, without needing to
 * also invalidate their Supabase session. See
 * docs/superpowers/specs/2026-09-19-admin-auth-design.md.
 */
export async function requireAdmin(): Promise<{ email: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    throw new UnauthorizedError("Not signed in");
  }

  const email = user.email.toLowerCase();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("admin_allowlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new UnauthorizedError(`${email} is not on the admin allowlist`);
  }

  return { email };
}
