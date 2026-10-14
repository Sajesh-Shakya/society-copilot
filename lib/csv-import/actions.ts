"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { parseAttendeeCsv, isCsvFile } from "./parser";
import {
  createSessionFromCsvSchema,
  importAttendanceCsv,
  syncAttendanceCsv,
} from "./importer";

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

export interface SyncCsvToSessionResult {
  success: boolean;
  message: string;
}

const sessionIdSchema = z.string().uuid();

/**
 * Re-syncs an EXISTING session's roster against a freshly re-exported CSV
 * -- the new file is treated as the current source of truth for who's
 * signed up (someone may have un-signed-up since the last export). See
 * syncAttendanceCsv for the exact add/skip/remove rules -- in short: new
 * people are added, people already on the roster are left alone, and a
 * not-yet-attended csv_import row whose person has dropped off the new
 * list is removed; a manually-added (manual_tick/walk_in) row or anyone
 * already marked attended is never removed.
 */
export async function syncCsvToSession(
  sessionId: string,
  formData: FormData
): Promise<SyncCsvToSessionResult> {
  await requireAdmin();

  const parsedSessionId = sessionIdSchema.safeParse(sessionId);
  if (!parsedSessionId.success) {
    return { success: false, message: "Invalid session." };
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
    const result = await syncAttendanceCsv({ sessionId: parsedSessionId.data, rows });
    const parts = [`${result.added} added`];
    if (result.removed > 0) parts.push(`${result.removed} removed (no longer signed up)`);
    if (result.skipped > 0) parts.push(`${result.skipped} unchanged`);
    return {
      success: true,
      message: parts.join(", ") + ".",
    };
  } catch (error) {
    console.error("syncCsvToSession: sync failed partway through:", error);
    return {
      success: false,
      message: "Sync failed partway through — check the roster before retrying.",
    };
  }
}
