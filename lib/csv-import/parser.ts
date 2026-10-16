import { read, utils } from "xlsx";
import { z } from "zod";
import { normalizeCid } from "@/lib/utils";

export interface AttendeeRow {
  firstName: string;
  surname: string;
  email: string;
  // Deliberately never used to MATCH/merge an existing person during CSV
  // import itself -- see the 2026-10-09 design doc's "Decisions already
  // made" (email alone decides that). importer.ts does persist it onto
  // person.cid (backfilling only, never overwriting) once a person is
  // resolved, since this value has turned out to reliably be a real
  // 8-digit Imperial CID in practice, not the ambiguous value the design
  // doc worried it might be -- that enables other subsystems (purchase
  // CID matching, see lib/purchase/matcher.ts) that had nothing to match
  // against before. Also stored verbatim on
  // attendance_record.raw_cid_or_card_number for audit either way.
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
  // raw: true keeps every cell in its original string/raw form instead of
  // letting xlsx auto-type numeric-looking cells as JS numbers, which would
  // silently drop leading zeros (e.g. "0123456" -> 123456) and lose
  // precision on long card numbers. First Name/Surname/Email are already
  // text, so this doesn't change their parsing.
  const workbook = read(buffer, { type: "buffer", raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = utils.sheet_to_json(sheet) as Record<string, unknown>[];

  const rows: AttendeeRow[] = [];
  const rowErrors: RowError[] = [];
  const seenEmails = new Set<string>();

  rawRows.forEach((raw) => {
    // xlsx's sheet_to_json() can skip fully-blank rows, so the forEach
    // index no longer lines up with the row's actual position in the file
    // once a blank line appears earlier on. __rowNum__ is xlsx's own
    // 0-indexed-from-the-sheet row number (the header row is row 0, so the
    // first data row is row 1), which already matches this module's
    // header-excluded, 1-indexed row-number contract directly -- no
    // further offset needed -- while still tracking the true row position
    // across any skipped blank rows.
    const rowNumber = (raw as { __rowNum__?: number }).__rowNum__ as number;
    const firstName = getField(raw, "First Name");
    const surname = getField(raw, "Surname");
    const email = getField(raw, "Email");
    const rawCidField = getField(raw, "CID/Card Number");
    const rawCidOrCardNumber = rawCidField ? normalizeCid(rawCidField) : null;

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

    const normalizedEmail = email!.toLowerCase();
    if (seenEmails.has(normalizedEmail)) {
      rowErrors.push({ row: rowNumber, message: `duplicate email "${email}"` });
      return;
    }
    seenEmails.add(normalizedEmail);

    rows.push({ firstName: firstName!, surname: surname!, email: email!, rawCidOrCardNumber });
  });

  return { rows, rowErrors };
}

export function isCsvFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".csv");
}
