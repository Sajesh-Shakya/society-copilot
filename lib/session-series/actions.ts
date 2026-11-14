"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { parseAttendeeCsv, isCsvFile } from "@/lib/csv-import/parser";
import type { AttendeeRow } from "@/lib/csv-import/parser";
import { createRecurringSeries, seriesTitleSchema } from "./create";
import { RecurrenceError, weeklyOccurrences } from "./recurrence";

export interface CreateRecurringSeriesActionResult {
  success: boolean;
  message: string;
  firstSessionId?: string;
}

/**
 * Creates a weekly recurring series (see createRecurringSeries). An optional
 * signup CSV is applied to the first occurrence only. All user-input problems
 * are returned as { success: false }; nothing is created unless the title,
 * recurrence and CSV (if given) all validate.
 */
export async function createRecurringSeriesAction(
  clubSlug: string,
  formData: FormData
): Promise<CreateRecurringSeriesActionResult> {
  const { clubId } = await requireAdmin(clubSlug);

  const title = seriesTitleSchema.safeParse(String(formData.get("title") ?? ""));
  if (!title.success) {
    return { success: false, message: "Enter a title (up to 200 characters)." };
  }
  const input = {
    title: title.data,
    firstDate: String(formData.get("firstDate") ?? ""),
    startTime: String(formData.get("startTime") ?? ""),
    endTime: String(formData.get("endTime") ?? ""),
    untilDate: String(formData.get("untilDate") ?? ""),
  };

  try {
    weeklyOccurrences(input);
  } catch (error) {
    if (error instanceof RecurrenceError) return { success: false, message: error.message };
    throw error;
  }

  let rows: AttendeeRow[] | undefined;
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    if (!isCsvFile(file.name)) {
      return { success: false, message: "File must be .csv format." };
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = parseAttendeeCsv(buffer);
    if (parsed.rowErrors.length > 0) {
      const detail = parsed.rowErrors.map((e) => `row ${e.row}: ${e.message}`).join("\n");
      return { success: false, message: `${parsed.rowErrors.length} row(s) failed:\n${detail}` };
    }
    if (parsed.rows.length === 0) {
      return { success: false, message: "No attendee rows found in the file." };
    }
    rows = parsed.rows;
  }

  try {
    const result = await createRecurringSeries({ ...input, rows }, clubId);
    let message = `Created ${result.sessionIds.length} weekly sessions.`;
    if (rows) message += ` Imported ${result.imported} attendee(s) into the first one.`;
    return { success: true, message, firstSessionId: result.sessionIds[0] };
  } catch (error) {
    if (error instanceof RecurrenceError) return { success: false, message: error.message };
    console.error("createRecurringSeriesAction: creation failed:", error);
    return {
      success: false,
      message: "Creating the series failed — nothing was kept. Check the sessions list before retrying.",
    };
  }
}
