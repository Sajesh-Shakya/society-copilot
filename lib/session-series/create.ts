import { z } from "zod";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { syncAttendanceCsv } from "@/lib/csv-import/importer";
import type { AttendeeRow } from "@/lib/csv-import/parser";
import { weeklyOccurrences } from "./recurrence";

export const seriesTitleSchema = z.string().trim().min(1).max(200);

export interface CreateRecurringSeriesInput {
  title: string;
  firstDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  untilDate: string; // YYYY-MM-DD
  rows?: AttendeeRow[];
}

export interface CreateRecurringSeriesResult {
  seriesId: string;
  sessionIds: string[];
  imported: number;
}

/**
 * Creates a weekly series: one session_series row plus one session per
 * occurrence (single bulk insert). A signup CSV, if given, is applied to the
 * FIRST occurrence only. No requireAdmin here (like importAttendanceCsv) so
 * integration tests can call it; the server action does the admin check.
 *
 * Title and occurrences are validated before any write, so a RecurrenceError
 * (or a bad title) leaves the DB untouched. If anything fails after the series
 * row exists, the created attendance records, sessions and the series row are
 * removed (best effort, in FK order) and the original error is rethrown.
 * People created by the roster import are intentionally kept.
 */
export async function createRecurringSeries(
  input: CreateRecurringSeriesInput,
  clubId: string
): Promise<CreateRecurringSeriesResult> {
  const title = seriesTitleSchema.parse(input.title);
  const occurrences = weeklyOccurrences(input);

  const scoped = createClubScopedClient(clubId);

  const { data: series, error: seriesError } = await scoped
    .from("session_series")
    .insert({ title })
    .select("id")
    .single();
  if (seriesError) throw seriesError;
  const seriesId = (series as unknown as { id: string }).id;

  try {
    const { data: inserted, error: sessionsError } = await scoped
      .from("session")
      .insert(
        occurrences.map((o) => ({
          title,
          starts_at: o.startsAt.toISOString(),
          ends_at: o.endsAt.toISOString(),
          series_id: seriesId,
        }))
      )
      .select("id, starts_at");
    if (sessionsError) throw sessionsError;

    const sessionIds = (inserted as unknown as Array<{ id: string; starts_at: string }>)
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
      .map((s) => s.id);
    if (sessionIds.length !== occurrences.length) {
      throw new Error(`Expected ${occurrences.length} sessions, database returned ${sessionIds.length}`);
    }

    let imported = 0;
    if (input.rows && input.rows.length > 0) {
      const result = await syncAttendanceCsv({ sessionId: sessionIds[0], rows: input.rows }, clubId);
      imported = result.added;
    }

    return { seriesId, sessionIds, imported };
  } catch (error) {
    await cleanupSeries(clubId, seriesId);
    throw error;
  }
}

/** Best effort: attendance records, then sessions, then the series row. Never throws. */
async function cleanupSeries(clubId: string, seriesId: string): Promise<void> {
  try {
    const scoped = createClubScopedClient(clubId);
    const { data: sessions } = await scoped.from("session").select("id").eq("series_id", seriesId);
    const ids = ((sessions ?? []) as unknown as Array<{ id: string }>).map((s) => s.id);
    if (ids.length > 0) {
      await scoped.from("attendance_record").delete().in("session_id", ids);
      await scoped.from("session").delete().in("id", ids);
    }
    await scoped.from("session_series").delete().eq("id", seriesId);
  } catch (cleanupError) {
    console.error("createRecurringSeries: cleanup failed:", cleanupError);
  }
}
