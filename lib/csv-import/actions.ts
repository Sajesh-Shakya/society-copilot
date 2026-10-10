"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { parseAttendeeCsv, isCsvFile } from "./parser";
import { createSessionFromCsvSchema, importAttendanceCsv } from "./importer";

export interface CreateSessionFromCsvResult {
  success: boolean;
  message: string;
  sessionId?: string;
}

/**
 * Fail-safe session creation for when eActivities' whatson/signups API is
 * down (see docs/superpowers/specs/2026-10-09-csv-attendance-import-design.md).
 * No eActivities call anywhere in this path.
 */
export async function createSessionFromCsv(formData: FormData): Promise<CreateSessionFromCsvResult> {
  await requireAdmin();

  const parsed = createSessionFromCsvSchema.safeParse({
    title: String(formData.get("title") ?? ""),
    startsAt: String(formData.get("startsAt") ?? ""),
  });
  if (!parsed.success) {
    return { success: false, message: "Enter a title and start time." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, message: "No file provided." };
  }
  if (!isCsvFile(file.name)) {
    return { success: false, message: "File must be .csv format." };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { rows, rowErrors } = parseAttendeeCsv(buffer);

  if (rowErrors.length > 0) {
    const detail = rowErrors.map((e) => `row ${e.row}: ${e.message}`).join("\n");
    return { success: false, message: `${rowErrors.length} row(s) failed:\n${detail}` };
  }
  if (rows.length === 0) {
    return { success: false, message: "No attendee rows found in the file." };
  }

  try {
    const result = await importAttendanceCsv({
      title: parsed.data.title,
      startsAt: parsed.data.startsAt,
      rows,
    });
    return {
      success: true,
      message: `Imported ${result.imported} attendee(s).`,
      sessionId: result.sessionId,
    };
  } catch (error) {
    console.error("createSessionFromCsv: import failed partway through:", error);
    return {
      success: false,
      message:
        "Import failed partway through — check /sessions for a possibly-incomplete session before retrying.",
    };
  }
}
