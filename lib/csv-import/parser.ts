import { read, utils } from "xlsx";
import { z } from "zod";

export interface AttendeeRow {
  firstName: string;
  surname: string;
  email: string;
  // Deliberately never used for identity matching -- see the 2026-10-09
  // design doc's "Decisions already made". Kept only so the caller can
  // persist it for audit (attendance_record.raw_cid_or_card_number).
  rawCidOrCardNumber: string | null;
}

export interface RowError {
  row: number; // 1-indexed, header row excluded (first data row = 1)
  message: string;
}

export interface ParseAttendeeCsvResult {
  rows: AttendeeRow[];
  rowErrors: RowError[];
}

const EMAIL_SCHEMA = z.email();

// Case-insensitive, whitespace-tolerant header lookup. xlsx's
// sheet_to_json() keys each row object by the literal header text found in
// the file, so "First Name", "first name", and " First Name" (BOM/encoding
// artifacts aside) all need to resolve to the same logical field.
function getField(row: Record<string, unknown>, name: string): string | undefined {
  const target = name.toLowerCase();
  const key = Object.keys(row).find((k) => k.trim().toLowerCase() === target);
  if (key === undefined) return undefined;
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Parses an uploaded attendee CSV (the roster export from eActivities' own
 * admin dashboard, used as a fail-safe while the eActivities whatson/
 * signups API is broken -- see the 2026-10-09 design doc). Required
 * columns: First Name, Surname, Email. Everything else (Date,
 * CID/Card Number, Login, Event Title, Signup Title, Attended) is read if
 * present but never required and never validated against other rows --
 * in particular, multiple distinct Date values in one file is normal
 * (Date is the signup date, not the event date) and never an error.
 *
 * Any row that fails validation is reported in rowErrors by its 1-indexed
 * row number (header excluded); the caller (lib/csv-import/actions.ts)
 * treats any rowErrors as a reason to import nothing at all, per the
 * design doc -- this function itself doesn't enforce that, it just reports.
 */
export function parseAttendeeCsv(buffer: Buffer): ParseAttendeeCsvResult {
  const workbook = read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = utils.sheet_to_json(sheet) as Record<string, unknown>[];

  const rows: AttendeeRow[] = [];
  const rowErrors: RowError[] = [];

  rawRows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const firstName = getField(raw, "First Name");
    const surname = getField(raw, "Surname");
    const email = getField(raw, "Email");
    const rawCidOrCardNumber = getField(raw, "CID/Card Number") ?? null;

    const missing: string[] = [];
    if (!firstName) missing.push("First Name");
    if (!surname) missing.push("Surname");
    if (!email) missing.push("Email");
    if (missing.length > 0) {
      rowErrors.push({ row: rowNumber, message: `missing ${missing.join(", ")}` });
      return;
    }

    if (!EMAIL_SCHEMA.safeParse(email).success) {
      rowErrors.push({ row: rowNumber, message: `invalid email "${email}"` });
      return;
    }

    rows.push({ firstName: firstName!, surname: surname!, email: email!, rawCidOrCardNumber });
  });

  return { rows, rowErrors };
}

export function isCsvFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".csv");
}
