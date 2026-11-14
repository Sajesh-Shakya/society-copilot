import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { chunk } from "@/lib/chunk";

/** Max ids per `.in()` filter / per delete statement. */
const CHUNK_SIZE = 100;

export interface SeriesDeletePlan {
  seriesId: string;
  /** Sessions with no attended record, ascending by starts_at. */
  toDelete: { id: string; startsAt: string }[];
  /** Sessions with at least one attended = true record; never deleted. */
  kept: { id: string; title: string; startsAt: string; attendedCount: number }[];
}

/** PostgREST caps a response at max_rows (1000 on hosted Supabase) regardless of .range(). */
const ATTENDED_PAGE_SIZE = 1000;

const GENERIC_FAILURE =
  "Reload to see what is left before retrying. Nothing with recorded attendance was lost.";

/**
 * User-facing text for a failed delete. Raw database text is never included
 * (callers console.error it server-side). 23503 = FK violation: an event in
 * the batch gained attendance after planning.
 */
export function describeDeleteFailure(error: { code?: string }, deleted: number): string {
  if (error.code === "23503") {
    return `An event in this batch now has recorded attendance, so it was not deleted. ${deleted} event(s) were deleted before this, and the unattended roster rows of the failing batch were already removed. Nothing with attendance was lost. Review the series and try again.`;
  }
  return `Deleting events failed after ${deleted} event(s) were deleted. ${GENERIC_FAILURE}`;
}

/** Thrown when a delete fails part-way; `deleted` sessions are already gone. */
export class SeriesDeleteError extends Error {
  constructor(message: string, readonly deleted: number) {
    super(message);
    this.name = "SeriesDeleteError";
  }
}

/**
 * What "delete this and all later events" would do. Loads the chosen session
 * through the club-scoped client (so another club's session id yields null),
 * then every session of the same series in this club starting at or after it.
 *
 * Kept rule: a session is kept iff it has at least one attendance_record with
 * attended = true, whether it is in the past or the future. Recorded
 * attendance is never destroyed; unattended roster rows (signups, CSV import)
 * are disposable.
 *
 * Returns null when the session is missing, in another club, or not part of a series.
 */
export async function planSeriesDelete(
  sessionId: string,
  clubId: string,
  pageSize: number = ATTENDED_PAGE_SIZE
): Promise<SeriesDeletePlan | null> {
  const scoped = createClubScopedClient(clubId);

  const { data: chosen, error: chosenError } = await scoped
    .from("session")
    .select("id, starts_at, series_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (chosenError) throw chosenError;
  if (!chosen) return null;
  const chosenRow = chosen as unknown as { id: string; starts_at: string; series_id: string | null };
  if (!chosenRow.series_id) return null;
  const seriesId = chosenRow.series_id;

  const { data: sessions, error: sessionsError } = await scoped
    .from("session")
    .select("id, title, starts_at")
    .eq("series_id", seriesId)
    .gte("starts_at", chosenRow.starts_at)
    .order("starts_at", { ascending: true })
    .range(0, 9999);
  if (sessionsError) throw sessionsError;
  const targets = (sessions ?? []) as unknown as { id: string; title: string; starts_at: string }[];

  const attendedBySession = new Map<string, number>();
  for (const ids of chunk(
    targets.map((s) => s.id),
    CHUNK_SIZE
  )) {
    // Page until a short page: the server caps rows per response, so a single
    // .range(0, 9999) can be silently truncated.
    for (let offset = 0; ; offset += pageSize) {
      const { data: rows, error: attendedError } = await scoped
        .from("attendance_record")
        .select("session_id")
        .eq("attended", true)
        .in("session_id", ids)
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (attendedError) throw attendedError;
      const page = (rows ?? []) as unknown as { session_id: string }[];
      for (const r of page) {
        attendedBySession.set(r.session_id, (attendedBySession.get(r.session_id) ?? 0) + 1);
      }
      if (page.length < pageSize) break;
    }
  }

  const toDelete: SeriesDeletePlan["toDelete"] = [];
  const kept: SeriesDeletePlan["kept"] = [];
  for (const s of targets) {
    const attendedCount = attendedBySession.get(s.id) ?? 0;
    if (attendedCount > 0) kept.push({ id: s.id, title: s.title, startsAt: s.starts_at, attendedCount });
    else toDelete.push({ id: s.id, startsAt: s.starts_at });
  }
  return { seriesId, toDelete, kept };
}

/**
 * Deletes the planned sessions. Re-plans (never trusts a client list), then,
 * per ascending chunk of <= 100: unattended attendance_record rows, then the
 * sessions. The attendance_record -> session FK is `no action`, so if an
 * attended tick lands after planning the session delete fails and nothing
 * recorded is lost. Any failure stops the run (the series row is then left in
 * place) and throws SeriesDeleteError saying how many sessions were already
 * deleted. Finally removes the session_series row if no session references it.
 */
export async function executeSeriesDelete(
  sessionId: string,
  clubId: string
): Promise<{ deleted: number; kept: number }> {
  const plan = await planSeriesDelete(sessionId, clubId);
  if (!plan) return { deleted: 0, kept: 0 };

  const scoped = createClubScopedClient(clubId);
  let deleted = 0;

  for (const part of chunk(
    plan.toDelete.map((s) => s.id),
    CHUNK_SIZE
  )) {
    const { error: recordsError } = await scoped
      .from("attendance_record")
      .delete()
      .in("session_id", part)
      .eq("attended", false);
    if (recordsError) {
      console.error("executeSeriesDelete: deleting roster rows failed:", recordsError);
      throw new SeriesDeleteError(describeDeleteFailure(recordsError, deleted), deleted);
    }

    const { error: sessionsError } = await scoped.from("session").delete().in("id", part);
    if (sessionsError) {
      console.error("executeSeriesDelete: deleting sessions failed:", sessionsError);
      throw new SeriesDeleteError(describeDeleteFailure(sessionsError, deleted), deleted);
    }
    deleted += part.length;
  }

  const { data: remaining, error: remainingError } = await scoped
    .from("session")
    .select("id")
    .eq("series_id", plan.seriesId)
    .limit(1);
  if (remainingError) {
    console.error("executeSeriesDelete: checking remaining sessions failed:", remainingError);
    throw new SeriesDeleteError(describeDeleteFailure({}, deleted), deleted);
  }
  if (((remaining ?? []) as unknown[]).length === 0) {
    const { error: seriesError } = await scoped.from("session_series").delete().eq("id", plan.seriesId);
    if (seriesError) {
      console.error("executeSeriesDelete: removing the series row failed:", seriesError);
      throw new SeriesDeleteError(describeDeleteFailure({}, deleted), deleted);
    }
  }

  return { deleted, kept: plan.kept.length };
}
