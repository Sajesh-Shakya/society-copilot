import { createAdminClient } from "@/lib/supabase/admin";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import type { Attendee } from "@/lib/eactivities/types";

export class SessionNotBoundError extends Error {
  constructor(sessionId: string) {
    super(
      `Session ${sessionId} has no eactivities_signup_id set. An admin must ` +
        `bind the session to a signup first (AC-8) — this can't be done ` +
        `automatically, since an event's attached signups aren't ` +
        `distinguishable via the API. The binding UI is task 3.0, not yet ` +
        `built; set it directly via SQL for testing.`
    );
    this.name = "SessionNotBoundError";
  }
}

export class SyncDebouncedError extends Error {
  constructor(sessionId: string, retryAfterMs: number) {
    super(
      `Session ${sessionId} was synced less than 60s ago; retry in ` +
        `${Math.ceil(retryAfterMs / 1000)}s. Debounced to avoid tripping ` +
        `eActivities' rate limit (5min IP ban) — see design.md.`
    );
    this.name = "SyncDebouncedError";
  }
}

const DEBOUNCE_MS = 60_000;

interface SyncResult {
  attendeesSeen: number;
  personsCreated: number;
  attendanceRecordsCreated: number;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Matches an eActivities attendee to an existing person record, or creates
 * one. CID-priority per the identity-matching rule: CID is the only
 * authoritative join key; email is used only because eActivities gives it
 * directly (not derived/guessed from name or shortcode); no fuzzy name
 * matching here (that's AC-4's separate, explicit admin-review flow).
 */
async function findOrCreatePerson(
  admin: AdminClient,
  attendee: Attendee
): Promise<{ id: string; created: boolean }> {
  if (attendee.CID) {
    const { data: byCid } = await admin
      .from("person")
      .select("id")
      .eq("cid", attendee.CID)
      .maybeSingle();
    if (byCid) return { id: byCid.id, created: false };
  }

  const email = attendee.Email.toLowerCase();
  const { data: byEmail } = await admin
    .from("person")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (byEmail) return { id: byEmail.id, created: false };

  const { data: created, error } = await admin
    .from("person")
    .insert({
      cid: attendee.CID,
      shortcode: attendee.Login,
      email: attendee.Email,
      full_name: `${attendee.FirstName} ${attendee.Surname}`.trim(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: created.id, created: true };
}

interface SyncOptions {
  // Test-only injection point — production callers never pass this, so
  // they always get the real EactivitiesProvider (real HTTP calls). Lets
  // tests exercise the debounce/idempotency logic without hitting the
  // live, rate-limited eActivities API.
  provider?: Pick<EactivitiesProvider, "getSignup">;
}

export async function syncSessionAttendance(
  sessionId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const admin = createAdminClient();

  const { data: session, error: sessionError } = await admin
    .from("session")
    .select("id, eactivities_signup_id, last_synced_at")
    .eq("id", sessionId)
    .single();
  if (sessionError) throw sessionError;
  if (!session.eactivities_signup_id) throw new SessionNotBoundError(sessionId);

  if (session.last_synced_at) {
    const elapsed = Date.now() - new Date(session.last_synced_at).getTime();
    if (elapsed < DEBOUNCE_MS) {
      throw new SyncDebouncedError(sessionId, DEBOUNCE_MS - elapsed);
    }
  }

  const provider = options.provider ?? new EactivitiesProvider();
  const signup = await provider.getSignup(session.eactivities_signup_id);

  let personsCreated = 0;
  let attendanceRecordsCreated = 0;

  for (const attendee of signup.Attendees) {
    const { id: personId, created } = await findOrCreatePerson(admin, attendee);
    if (created) personsCreated += 1;

    // upsert + ignoreDuplicates: true is INSERT ... ON CONFLICT DO NOTHING.
    // Never overwrites an existing tick (manual or prior sync) — satisfies
    // AC-6's "without duplicating or losing existing ticks." select() after
    // an ignored upsert returns no row, so its presence tells us whether a
    // new attendance_record was actually created.
    const { data: inserted, error: insertError } = await admin
      .from("attendance_record")
      .upsert(
        { person_id: personId, session_id: sessionId, source: "signup_sync" },
        { onConflict: "person_id,session_id", ignoreDuplicates: true }
      )
      .select("id");
    if (insertError) throw insertError;
    if (inserted && inserted.length > 0) attendanceRecordsCreated += 1;
  }

  await admin
    .from("session")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", sessionId);

  // Observability only — see design.md's Architecture Decisions on why the
  // real per-session debounce/window logic uses session.last_synced_at instead.
  await admin.from("sync_cursor").upsert({
    source: "eactivities",
    last_synced_at: new Date().toISOString(),
    last_synced_id: session.eactivities_signup_id,
  });

  return {
    attendeesSeen: signup.Attendees.length,
    personsCreated,
    attendanceRecordsCreated,
  };
}
