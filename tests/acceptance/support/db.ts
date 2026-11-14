import { randomBytes } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Service-role client against the real dev Supabase project. EVERY destructive
 * statement in the acceptance suite goes through the helpers below, each of
 * which is scoped by a throwaway club id and calls assertThrowawayClub first.
 */
export const adminDb = createAdminClient();

export const THROWAWAY_SLUG_PREFIX = "e2e-";
const STALE_AFTER_MS = 60 * 60 * 1000;

export type AcceptanceContext = {
  clubId: string;
  clubSlug: string;
  email: string;
  password: string;
  userId?: string;
};

export function randomHex(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

/** Hard guard: re-reads the club row and refuses anything not slugged `e2e-*`. */
export async function assertThrowawayClub(clubId: string): Promise<void> {
  if (!clubId) throw new Error("assertThrowawayClub: empty club id");
  const { data, error } = await adminDb.from("club").select("id, slug").eq("id", clubId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`assertThrowawayClub: no club ${clubId}`);
  if (!data.slug.startsWith(THROWAWAY_SLUG_PREFIX)) {
    throw new Error(`assertThrowawayClub: refusing to touch club "${data.slug}" (not a throwaway e2e- club)`);
  }
}

// FK-dependency order: children before parents.
// Any NEW club-scoped table MUST be added here, or club deletion (and the
// stale sweep, which then throws on every run) will fail on its FK.
const DATA_TABLES_IN_DELETE_ORDER = [
  "chase_email",
  "attendance_record",
  "purchase",
  "purchase_upload",
  "product",
  "sync_cursor",
  "session",
  "session_series",
  "person",
] as const;

/** Deletes all club-scoped data (not the club, admin row or auth user) of a throwaway club. */
export async function deleteClubData(clubId: string): Promise<void> {
  await assertThrowawayClub(clubId);
  for (const table of DATA_TABLES_IN_DELETE_ORDER) {
    const { error } = await adminDb.from(table).delete().eq("club_id", clubId);
    if (error) throw new Error(`deleteClubData(${table}): ${error.message}`);
  }
}

/** Deletes a throwaway club completely: data, credentials, admin rows, the club row. */
export async function deleteClub(clubId: string): Promise<void> {
  await assertThrowawayClub(clubId);
  await deleteClubData(clubId);
  for (const table of ["club_credential", "admin"] as const) {
    const { error } = await adminDb.from(table).delete().eq("club_id", clubId);
    if (error) throw new Error(`deleteClub(${table}): ${error.message}`);
  }
  const { error } = await adminDb.from("club").delete().eq("id", clubId);
  if (error) throw new Error(`deleteClub(club): ${error.message}`);
}

const ACCEPTANCE_EMAIL = /^acceptance-.+@example\.test$/;

/**
 * Deletes an auth user, but only one whose STORED email is an
 * acceptance-*@example.test address (looked up by id, not trusted from the caller).
 */
export async function deleteAcceptanceUser(userId: string): Promise<void> {
  const { data, error: getError } = await adminDb.auth.admin.getUserById(userId);
  if (getError || !data?.user) {
    if (!getError || /not found/i.test(getError.message)) return; // already gone
    throw new Error(`deleteAcceptanceUser: ${getError.message}`);
  }
  const storedEmail = data.user.email ?? "";
  if (!ACCEPTANCE_EMAIL.test(storedEmail)) {
    throw new Error(`deleteAcceptanceUser: refusing to delete non-acceptance user "${storedEmail}"`);
  }
  const { error } = await adminDb.auth.admin.deleteUser(userId);
  if (error && !/not found/i.test(error.message)) {
    throw new Error(`deleteAcceptanceUser: ${error.message}`);
  }
}

/** Removes leftovers of crashed runs: e2e-% clubs and acceptance users older than 1 hour. */
export async function sweepStale(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data: clubs, error } = await adminDb
    .from("club")
    .select("id, slug")
    .like("slug", `${THROWAWAY_SLUG_PREFIX}%`)
    .lt("created_at", cutoff);
  if (error) throw error;
  for (const club of clubs ?? []) await deleteClub(club.id);

  const cutoffMs = Date.parse(cutoff);
  const stale: string[] = [];
  for (let page = 1; ; page++) {
    const { data: users, error: usersError } = await adminDb.auth.admin.listUsers({ page, perPage: 1000 });
    if (usersError) throw usersError;
    for (const user of users.users) {
      if (user.email && ACCEPTANCE_EMAIL.test(user.email) && Date.parse(user.created_at) < cutoffMs) {
        stale.push(user.id);
      }
    }
    if (users.users.length < 1000) break;
  }
  for (const id of stale) await deleteAcceptanceUser(id);
}
