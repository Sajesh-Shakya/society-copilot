import { adminDb, randomHex, sweepStale, type AcceptanceContext } from "./support/db";

/**
 * Creates the ONE throwaway club + admin row + auth user for this run and
 * publishes it to workers (and globalTeardown) via the ACCEPTANCE_CONTEXT env
 * var. The password lives only in that env var; it is never written to disk or logged.
 */
export default async function globalSetup() {
  await sweepStale();

  const suffix = randomHex(4);
  const context: AcceptanceContext = {
    clubId: "",
    clubSlug: `e2e-${suffix}`,
    email: `acceptance-${suffix}@example.test`,
    password: `Pw-${randomHex(16)}`,
  };

  const { data: club, error: clubError } = await adminDb
    .from("club")
    .insert({ name: `E2E Acceptance ${suffix}`, slug: context.clubSlug })
    .select("id")
    .single();
  if (clubError) throw clubError;
  context.clubId = club.id;
  // Publish early so globalTeardown can clean up even if a later step throws.
  process.env.ACCEPTANCE_CONTEXT = JSON.stringify(context);

  const { data: created, error: userError } = await adminDb.auth.admin.createUser({
    email: context.email,
    password: context.password,
    email_confirm: true,
  });
  if (userError) throw userError;
  context.userId = created.user.id;
  process.env.ACCEPTANCE_CONTEXT = JSON.stringify(context);

  const { error: adminError } = await adminDb.from("admin").insert({ email: context.email, club_id: context.clubId });
  if (adminError) throw adminError;
}
