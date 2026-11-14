import { adminDb, deleteAcceptanceUser, deleteClub, type AcceptanceContext } from "./support/db";

/** Idempotent: removes the run's throwaway club (all data), admin row and auth user. */
export default async function globalTeardown() {
  const raw = process.env.ACCEPTANCE_CONTEXT;
  if (!raw) return;
  const context = JSON.parse(raw) as AcceptanceContext;

  if (context.clubId) {
    const { data: club, error } = await adminDb.from("club").select("id").eq("id", context.clubId).maybeSingle();
    if (error) throw error;
    if (club) await deleteClub(context.clubId);
  }
  if (context.userId) await deleteAcceptanceUser(context.userId, context.email);
}
