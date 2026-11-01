import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export class UnauthorizedError extends Error {}

const NOT_AUTHORIZED_MESSAGE = "Not authorized for this club.";

/**
 * The club-membership check, factored out from requireAdmin so it's
 * directly testable without a real authenticated request (requireAdmin
 * itself depends on lib/supabase/server.ts's cookie-based session, which
 * integration tests can't easily fake). Returns the identical
 * NOT_AUTHORIZED_MESSAGE whether clubSlug doesn't exist or the given email
 * just isn't an admin of it -- the error must never reveal which club
 * slugs are valid.
 */
export async function checkAdminForClub(
  email: string,
  clubSlug: string
): Promise<{ clubId: string; clubName: string }> {
  const admin = createAdminClient();

  const { data: club, error: clubError } = await admin
    .from("club")
    .select("id, name")
    .eq("slug", clubSlug)
    .maybeSingle();
  if (clubError) throw clubError;
  if (!club) throw new UnauthorizedError(NOT_AUTHORIZED_MESSAGE);

  const { data: row, error: adminError } = await admin
    .from("admin")
    .select("email")
    .eq("email", email.toLowerCase())
    .eq("club_id", club.id)
    .maybeSingle();
  if (adminError) throw adminError;
  if (!row) throw new UnauthorizedError(NOT_AUTHORIZED_MESSAGE);

  return { clubId: club.id, clubName: club.name };
}

// Transitional default -- DELETE this default (and this comment) in Task 9,
// once Tasks 6-7 have converted every caller to pass clubSlug explicitly.
// Without it, every not-yet-converted caller would fail to compile the
// moment this task lands, for the entire span until Task 7 finishes.
const TRANSITIONAL_DEFAULT_CLUB_SLUG = "judo";

/**
 * The actual enforcement point for admin-only Server Actions and pages.
 * Re-checks club membership on every call, same as the pre-multi-tenancy
 * version re-checked admin_allowlist, so revoking access takes effect
 * immediately without invalidating the Supabase session.
 */
export async function requireAdmin(
  clubSlug: string = TRANSITIONAL_DEFAULT_CLUB_SLUG
): Promise<{ email: string; clubId: string; clubName: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    throw new UnauthorizedError("Not signed in");
  }

  const email = user.email.toLowerCase();
  const { clubId, clubName } = await checkAdminForClub(email, clubSlug);
  return { email, clubId, clubName };
}

/**
 * Every club a signed-in email administers -- used by the post-sign-in
 * redirect (lib/auth/actions.ts) and the multi-club picker (app/select-club).
 */
export async function listAdminClubs(
  email: string
): Promise<{ clubId: string; slug: string; name: string }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("admin")
    .select("club_id, club:club_id(slug, name)")
    .eq("email", email.toLowerCase());
  if (error) throw error;

  return (data ?? []).map((row) => {
    // supabase-js types a to-one FK select as an array; it's always exactly
    // one row here since club_id is not-null with a FK (same pattern as
    // lib/csv-import/importer.ts's person:person_id select).
    const club = Array.isArray(row.club) ? row.club[0] : row.club;
    return { clubId: row.club_id, slug: club.slug, name: club.name };
  });
}
