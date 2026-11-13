import { cache } from "react";
import { getSignedInEmail } from "@/lib/auth/session";
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

  // One round trip: the !inner join drops admin rows whose club doesn't match
  // the slug, so an unknown slug and a non-admin both come back as no row.
  const { data: row, error } = await admin
    .from("admin")
    .select("club_id, club:club_id!inner(id, name, slug)")
    .eq("email", email.toLowerCase())
    .eq("club.slug", clubSlug)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new UnauthorizedError(NOT_AUTHORIZED_MESSAGE);

  // supabase-js may type a to-one join as an array (same as listAdminClubs).
  const club = Array.isArray(row.club) ? row.club[0] : row.club;
  if (!club) throw new UnauthorizedError(NOT_AUTHORIZED_MESSAGE);

  return { clubId: club.id, clubName: club.name };
}

/**
 * The actual enforcement point for admin-only Server Actions and pages.
 * Re-checks club membership against the DB on every request, so revoking
 * access takes effect immediately without invalidating the Supabase session.
 * Memoised with React cache so repeated calls for the same slug within a
 * single request (layout + page + actions) share one lookup; the cache never
 * outlives the request.
 */
export const requireAdmin = cache(
  async (
    clubSlug: string
  ): Promise<{ email: string; clubId: string; clubName: string }> => {
    const email = await getSignedInEmail();
    if (!email) {
      throw new UnauthorizedError("Not signed in");
    }

    const { clubId, clubName } = await checkAdminForClub(email, clubSlug);
    return { email, clubId, clubName };
  }
);

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
