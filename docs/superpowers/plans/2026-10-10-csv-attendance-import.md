# CSV Attendance Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create a session and populate its attendance roster from a CSV exported manually from eActivities' own dashboard, with zero calls to the (currently broken) eActivities API.

**Architecture:** A pure CSV parser (`parser.ts`) turns an uploaded file into validated rows or row-level errors. A pure importer (`importer.ts`) takes validated rows plus a title/start time and writes a new `session`, matching/creating `person` rows by email, and inserting `attendance_record` rows with a new `csv_import` source. A thin `"use server"` action wires `requireAdmin()`, the parser, and the importer together and is the only piece the UI calls. This mirrors the existing split between `lib/chase/actions.ts` (auth-gated) and `lib/chase/approval-writer.ts` (pure, directly testable) already used in this codebase.

**Tech Stack:** Next.js App Router Server Actions, Supabase (admin client, Postgres), the `xlsx` package (already a dependency — parses CSV as well as XLSX), Zod, Playwright-as-test-runner (unit + integration, per this repo's existing convention).

**Spec:** `docs/superpowers/specs/2026-10-09-csv-attendance-import-design.md`

## Global Constraints

- Every exported Server Action must call `requireAdmin()` first (see `lib/auth/require-admin.ts` and every existing file under `lib/attendance/actions.ts`, `lib/xlsx/uploader.ts`, `lib/chase/actions.ts`).
- Identity matching is **email-only** — no CID/Card-Number matching, no fuzzy name matching. Exact rule from the spec: "email alone decides whether a row is an existing person or a new one."
- `attendance_record.source` for rows created here is the literal string `'csv_import'` — never `'signup_sync'` or `'manual_tick'`.
- New `attendance_record` rows default to `attended: false` (not the column's own `true` default) — per the spec's explicit decision that a blank `Attended` column means "unknown," not "attended."
- The CSV's `Date` column is the *signup* date, not the event date, and is never persisted anywhere.
- No cross-row date-consistency validation — a file may contain many different signup dates.
- Required CSV columns (case-insensitive header match): `First Name`, `Surname`, `Email`. Everything else (`Date`, `CID/Card Number`, `Login`, `Event Title`, `Signup Title`, `Attended`) is read-if-present but never required.
- A file with any invalid row writes nothing (no session, no people, no attendance rows) — report every failing row by number in one message rather than partially importing.
- `session.eactivities_event_id` / `eactivities_signup_id` stay `null` for sessions created this way.

## Review Focus

- **Leading/trailing whitespace in Email/First Name/Surname.** The real eActivities API docs' own example data has a literal `" joe.bloggs50@imperial.ac.uk "` with surrounding spaces — untrimmed values would create a different "person" on every re-export of the same roster. Covered in Task 2 (parser trims every field) and Task 3 (same email, different case, matches one person).
- **A non-`.csv` file uploaded to this importer** (e.g. the `.xlsx` file meant for the purchases importer). A reasonable admin expects a clear rejection, not a garbage parse or silent wrong behavior. Covered in Task 2 (`isCsvFile` helper + test).
- **Blank title or blank/invalid start time.** An admin clicking submit with an empty field should get a clear validation message, not a session with an empty title. Covered in Task 3 (schema unit test) since the schema is exported and directly testable without needing `requireAdmin()`.
- **A CSV with a byte-order-mark (BOM) on the first header** — common when a spreadsheet tool (Excel/Numbers) exports CSV on Windows/Mac. If header matching breaks on a BOM-prefixed `"First Name"`, every row in an otherwise-valid real-world export would wrongly fail as "missing First Name." Covered in Task 2.
- **Two rows in the same file with the same email** (duplicate roster entry, or someone appearing in two signup rows). Without a within-file duplicate guard, the second `attendance_record` insert hits `UNIQUE(person_id, session_id)` and throws partway through, per the spec's accepted "known gap" — but the resulting error message should still be comprehensible, not a raw Postgres error. Covered in Task 3 (integration test asserts a clear failure message, not a thrown exception reaching the caller).

---

### Task 1: Migration — `csv_import` source + raw CID/card-number audit column

**Files:**
- Create: `supabase/migrations/20261010090000_add_csv_import_source_and_raw_cid.sql`

**Interfaces:**
- Produces: `attendance_record.source` now accepts `'csv_import'` in addition to the existing three values. New nullable column `attendance_record.raw_cid_or_card_number text`.

- [ ] **Step 1: Write the migration**

```sql
-- Migration: add csv_import attendance source + raw CID/card-number audit column
-- docs/superpowers/specs/2026-10-09-csv-attendance-import-design.md

alter table public.attendance_record drop constraint attendance_record_source_check;
alter table public.attendance_record add constraint attendance_record_source_check
  check (source in ('signup_sync','manual_tick','walk_in','csv_import'));

alter table public.attendance_record add column raw_cid_or_card_number text;

comment on column public.attendance_record.raw_cid_or_card_number is
  'Raw CID/Card Number value from a csv_import row, kept for audit only -- never used to match/merge person records (see 2026-10-09 design doc). Null for every other source.';
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tool `mcp__supabase__apply_migration` with `name: "add_csv_import_source_and_raw_cid"` and `query` set to the exact SQL from Step 1. This project's migrations are applied directly against the live Supabase project this way (not via a local `supabase db push` — there's no local Supabase stack in use here; every prior migration file in `supabase/migrations/` was applied the same way during its own implementation).

- [ ] **Step 3: Verify**

Run this against the live project (e.g. via the Supabase MCP `execute_sql` tool, matching how every other migration in this project history was verified):

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.attendance_record'::regclass
  and conname = 'attendance_record_source_check';
```

Expected: the definition includes `'csv_import'` alongside the three existing values.

```sql
select column_name, data_type, is_nullable from information_schema.columns
where table_name = 'attendance_record' and column_name = 'raw_cid_or_card_number';
```

Expected: one row, `data_type = text`, `is_nullable = YES`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261010090000_add_csv_import_source_and_raw_cid.sql
git commit -m "feat(attendance): add csv_import source and raw CID/card-number audit column"
```

---

### Task 2: CSV parser

**Files:**
- Create: `lib/csv-import/parser.ts`
- Test: `tests/unit/csv-import-parser.spec.ts`

**Interfaces:**
- Produces: `AttendeeRow` (`{ firstName: string; surname: string; email: string; rawCidOrCardNumber: string | null }`), `RowError` (`{ row: number; message: string }`), `ParseAttendeeCsvResult` (`{ rows: AttendeeRow[]; rowErrors: RowError[] }`), `parseAttendeeCsv(buffer: Buffer): ParseAttendeeCsvResult`, `isCsvFile(filename: string): boolean`.
- Consumes: nothing from earlier tasks (this is the first code task).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/csv-import-parser.spec.ts
import { test, expect } from "@playwright/test";
import { parseAttendeeCsv, isCsvFile } from "@/lib/csv-import/parser";

function csvBuffer(text: string): Buffer {
  return Buffer.from(text, "utf-8");
}

const VALID_CSV = `Date,CID/Card Number,Login,First Name,Surname,Email,Event Title,Signup Title,Attended
02/10/2026,2577809,asg124,Aaron,Garcia,aaron.garcia25@imperial.ac.uk,Judo Taster session,Judo Taster session,
04/10/2026,2798711,aba126,Abbas,Azani,abbas.azani26@imperial.ac.uk,Judo Taster session,Judo Taster session,`;

test.describe("parseAttendeeCsv", () => {
  test("parses a valid file into AttendeeRow[] with no errors", () => {
    const result = parseAttendeeCsv(csvBuffer(VALID_CSV));
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toEqual([
      {
        firstName: "Aaron",
        surname: "Garcia",
        email: "aaron.garcia25@imperial.ac.uk",
        rawCidOrCardNumber: "2577809",
      },
      {
        firstName: "Abbas",
        surname: "Azani",
        email: "abbas.azani26@imperial.ac.uk",
        rawCidOrCardNumber: "2798711",
      },
    ]);
  });

  test("does not error on multiple distinct signup dates in one file", () => {
    // VALID_CSV above already has two different dates (02/10 and 04/10) --
    // this is the explicit non-requirement from the spec, not a bug.
    const result = parseAttendeeCsv(csvBuffer(VALID_CSV));
    expect(result.rowErrors).toEqual([]);
  });

  test("reports a row missing Email by row number, 1-indexed, header excluded", () => {
    const csv = `First Name,Surname,Email
Aaron,Garcia,
Abbas,Azani,abbas.azani26@imperial.ac.uk`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rows).toHaveLength(1);
    expect(result.rowErrors).toEqual([{ row: 1, message: "missing Email" }]);
  });

  test("reports a row missing First Name", () => {
    const csv = `First Name,Surname,Email
,Garcia,aaron.garcia25@imperial.ac.uk`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rowErrors).toEqual([{ row: 1, message: "missing First Name" }]);
  });

  test("reports a row missing Surname", () => {
    const csv = `First Name,Surname,Email
Aaron,,aaron.garcia25@imperial.ac.uk`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rowErrors).toEqual([{ row: 1, message: "missing Surname" }]);
  });

  test("reports a row with an invalid email", () => {
    const csv = `First Name,Surname,Email
Aaron,Garcia,not-an-email`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rowErrors).toEqual([{ row: 1, message: 'invalid email "not-an-email"' }]);
  });

  test("trims leading/trailing whitespace from every field", () => {
    // Matches the real eActivities API docs' own example data, which has
    // literal surrounding spaces: " joe.bloggs50@imperial.ac.uk ".
    const csv = `First Name,Surname,Email
 Joe , Bloggs , joe.bloggs50@imperial.ac.uk `;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toEqual([
      { firstName: "Joe", surname: "Bloggs", email: "joe.bloggs50@imperial.ac.uk", rawCidOrCardNumber: null },
    ]);
  });

  test("header matching is case-insensitive", () => {
    const csv = `first name,SURNAME,eMail
Aaron,Garcia,aaron.garcia25@imperial.ac.uk`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rowErrors).toEqual([]);
    expect(result.rows[0].firstName).toBe("Aaron");
  });

  test("tolerates a byte-order mark on the first header", () => {
    const csv = `﻿First Name,Surname,Email
Aaron,Garcia,aaron.garcia25@imperial.ac.uk`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  test("missing CID/Card Number column entirely is not an error; rawCidOrCardNumber is null", () => {
    const csv = `First Name,Surname,Email
Aaron,Garcia,aaron.garcia25@imperial.ac.uk`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rows[0].rawCidOrCardNumber).toBeNull();
  });
});

test.describe("isCsvFile", () => {
  test("accepts .csv regardless of case", () => {
    expect(isCsvFile("roster.csv")).toBe(true);
    expect(isCsvFile("ROSTER.CSV")).toBe(true);
  });

  test("rejects other extensions", () => {
    expect(isCsvFile("roster.xlsx")).toBe(false);
    expect(isCsvFile("roster")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test tests/unit/csv-import-parser.spec.ts`
Expected: FAIL — `Cannot find module '@/lib/csv-import/parser'`.

- [ ] **Step 3: Write the parser**

```ts
// lib/csv-import/parser.ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx playwright test tests/unit/csv-import-parser.spec.ts`
Expected: all tests PASS.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/csv-import/parser.ts tests/unit/csv-import-parser.spec.ts
git commit -m "feat(csv-import): add attendee CSV parser"
```

---

### Task 3: Importer (pure DB-writing logic)

**Files:**
- Create: `lib/csv-import/importer.ts`
- Test: `tests/integration/csv-import.spec.ts`

**Interfaces:**
- Consumes: `AttendeeRow` from `lib/csv-import/parser.ts` (Task 2).
- Produces: `createSessionFromCsvSchema` (Zod schema for `{ title, startsAt }`), `importAttendanceCsv(input: { title: string; startsAt: string; rows: AttendeeRow[] }): Promise<{ sessionId: string; imported: number }>`. Throws on any DB error — callers (Task 4's action) catch and translate to a user-facing message. Does **not** call `requireAdmin()` — mirrors `lib/chase/approval-writer.ts`'s split from `lib/chase/actions.ts`, so this is directly testable without a real admin session.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/csv-import.spec.ts
import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { importAttendanceCsv, createSessionFromCsvSchema } from "@/lib/csv-import/importer";
import type { AttendeeRow } from "@/lib/csv-import/parser";

const admin = createAdminClient();

function row(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    firstName: "Csv",
    surname: "Import Test",
    email: `csv-import-test-${crypto.randomUUID()}@example.test`,
    rawCidOrCardNumber: null,
    ...overrides,
  };
}

test.describe("createSessionFromCsvSchema", () => {
  test("rejects a blank title", () => {
    const result = createSessionFromCsvSchema.safeParse({ title: "", startsAt: "2026-10-15T18:00:00.000Z" });
    expect(result.success).toBe(false);
  });

  test("rejects a blank startsAt", () => {
    const result = createSessionFromCsvSchema.safeParse({ title: "Taster Session", startsAt: "" });
    expect(result.success).toBe(false);
  });

  test("accepts a valid title and ISO startsAt", () => {
    const result = createSessionFromCsvSchema.safeParse({
      title: "Taster Session",
      startsAt: "2026-10-15T18:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

test.describe("importAttendanceCsv", () => {
  let sessionIds: string[] = [];
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length > 0) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (personIds.length > 0) {
      await admin.from("person").delete().in("id", personIds);
      personIds = [];
    }
  });

  test("creates a session and one attendance_record per row, source csv_import, attended false", async () => {
    const rows = [row(), row()];
    const result = await importAttendanceCsv({
      title: "CSV Import Test Session",
      startsAt: "2026-10-15T18:00:00.000Z",
      rows,
    });
    sessionIds.push(result.sessionId);
    expect(result.imported).toBe(2);

    const { data: session } = await admin
      .from("session")
      .select("title, starts_at, eactivities_signup_id")
      .eq("id", result.sessionId)
      .single();
    expect(session!.title).toBe("CSV Import Test Session");
    expect(session!.eactivities_signup_id).toBeNull();

    const { data: records } = await admin
      .from("attendance_record")
      .select("source, attended, raw_cid_or_card_number, person_id")
      .eq("session_id", result.sessionId);
    expect(records).toHaveLength(2);
    for (const record of records!) {
      expect(record.source).toBe("csv_import");
      expect(record.attended).toBe(false);
      personIds.push(record.person_id);
    }
  });

  test("reuses an existing person matched by email instead of creating a duplicate", async () => {
    const email = `csv-import-existing-${crypto.randomUUID()}@example.test`;
    const { data: existing, error } = await admin
      .from("person")
      .insert({ full_name: "Existing Person", email })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(existing.id);

    const result = await importAttendanceCsv({
      title: "CSV Import Reuse Test",
      startsAt: "2026-10-15T18:00:00.000Z",
      rows: [row({ email })],
    });
    sessionIds.push(result.sessionId);

    const { count: personCount } = await admin
      .from("person")
      .select("id", { count: "exact", head: true })
      .ilike("email", email);
    expect(personCount).toBe(1);

    const { data: record } = await admin
      .from("attendance_record")
      .select("person_id")
      .eq("session_id", result.sessionId)
      .single();
    expect(record!.person_id).toBe(existing.id);
  });

  test("matches an existing person by email case-insensitively", async () => {
    const email = `csv-import-case-${crypto.randomUUID()}@example.test`;
    const { data: existing, error } = await admin
      .from("person")
      .insert({ full_name: "Case Test Person", email })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(existing.id);

    const result = await importAttendanceCsv({
      title: "CSV Import Case Test",
      startsAt: "2026-10-15T18:00:00.000Z",
      rows: [row({ email: email.toUpperCase() })],
    });
    sessionIds.push(result.sessionId);

    const { count: personCount } = await admin
      .from("person")
      .select("id", { count: "exact", head: true })
      .ilike("email", email);
    expect(personCount).toBe(1);
  });

  test("stores rawCidOrCardNumber on the attendance_record for audit, unused for matching", async () => {
    const result = await importAttendanceCsv({
      title: "CSV Import Raw CID Test",
      startsAt: "2026-10-15T18:00:00.000Z",
      rows: [row({ rawCidOrCardNumber: "2577809" })],
    });
    sessionIds.push(result.sessionId);

    const { data: record } = await admin
      .from("attendance_record")
      .select("raw_cid_or_card_number, person_id")
      .eq("session_id", result.sessionId)
      .single();
    expect(record!.raw_cid_or_card_number).toBe("2577809");
    personIds.push(record!.person_id);
  });

  test("a duplicate email within the same file produces a clear error, not a raw DB exception", async () => {
    const email = `csv-import-dup-${crypto.randomUUID()}@example.test`;
    await expect(
      importAttendanceCsv({
        title: "CSV Import Duplicate Test",
        startsAt: "2026-10-15T18:00:00.000Z",
        rows: [row({ email }), row({ email })],
      })
    ).rejects.toThrow(/duplicate/i);

    // Clean up whatever partial state the duplicate-row failure left behind
    // -- the spec explicitly accepts this as a known gap (no auto-rollback).
    const { data: leftoverSessions } = await admin
      .from("session")
      .select("id")
      .eq("title", "CSV Import Duplicate Test");
    for (const s of leftoverSessions ?? []) {
      sessionIds.push(s.id);
      const { data: records } = await admin
        .from("attendance_record")
        .select("person_id")
        .eq("session_id", s.id);
      for (const r of records ?? []) personIds.push(r.person_id);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/csv-import.spec.ts`
Expected: FAIL — `Cannot find module '@/lib/csv-import/importer'`.

- [ ] **Step 3: Write the importer**

```ts
// lib/csv-import/importer.ts
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AttendeeRow } from "./parser";

// Mirrors lib/attendance/actions.ts's createSessionFromSignup schema for
// startsAt (accept either an offset-qualified ISO datetime or any
// non-empty string the caller has already normalized).
export const createSessionFromCsvSchema = z.object({
  title: z.string().min(1).max(200),
  startsAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
});

export interface ImportAttendanceCsvInput {
  title: string;
  startsAt: string;
  rows: AttendeeRow[];
}

export interface ImportAttendanceCsvResult {
  sessionId: string;
  imported: number;
}

/**
 * Pure DB-writing logic for the CSV-import fail-safe (see the 2026-10-09
 * design doc) -- no requireAdmin() call here, deliberately, so integration
 * tests can call it directly. The "use server" action in actions.ts is the
 * only production caller and is responsible for the admin check, CSV
 * parsing, and translating a thrown error here into a user-facing message.
 *
 * Creates a brand-new session (eactivities_event_id/signup_id left null)
 * and one attendance_record per row (source: 'csv_import', attended:
 * false -- see the design doc's "blank Attended column means unknown, not
 * attended" decision). Matches/creates person rows by email only; CID/Card
 * Number is never used to match, only stored for audit.
 *
 * Not wrapped in a transaction (no code in this codebase uses one --
 * Supabase-js doesn't expose multi-statement transactions directly, and
 * every other multi-step write here, e.g. createSessionFromSignup, accepts
 * the same partial-failure risk). A thrown error partway through leaves
 * the session and whatever rows succeeded so far in place; the caller
 * surfaces this as a failure and the admin can inspect/retry.
 */
export async function importAttendanceCsv(
  input: ImportAttendanceCsvInput
): Promise<ImportAttendanceCsvResult> {
  const admin = createAdminClient();

  const { data: session, error: sessionError } = await admin
    .from("session")
    .insert({ title: input.title, starts_at: new Date(input.startsAt).toISOString() })
    .select("id")
    .single();
  if (sessionError) throw sessionError;

  for (const row of input.rows) {
    const email = row.email.toLowerCase();
    const { data: existing, error: lookupError } = await admin
      .from("person")
      .select("id")
      .ilike("email", email)
      .maybeSingle();
    if (lookupError) throw lookupError;

    let personId: string;
    if (existing) {
      personId = existing.id;
    } else {
      const { data: created, error: personError } = await admin
        .from("person")
        .insert({
          email: row.email,
          full_name: `${row.firstName} ${row.surname}`.trim(),
          identity_confidence: "confirmed",
        })
        .select("id")
        .single();
      if (personError) throw personError;
      personId = created.id;
    }

    const { error: attendanceError } = await admin.from("attendance_record").insert({
      person_id: personId,
      session_id: session.id,
      source: "csv_import",
      attended: false,
      raw_cid_or_card_number: row.rawCidOrCardNumber,
    });
    if (attendanceError) throw attendanceError;
  }

  return { sessionId: session.id, imported: input.rows.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx playwright test --config=playwright.integration.config.ts tests/integration/csv-import.spec.ts`
Expected: all tests PASS. (The duplicate-email test expects a thrown error whose message matches `/duplicate/i` — Postgres's unique-violation error on `attendance_record`'s `UNIQUE(person_id, session_id)` constraint includes the word "duplicate" in its message; if this fails, read the actual thrown error message and adjust the regex to match what Postgres/PostgREST actually returns, don't change the production behavior to fit the test.)

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/csv-import/importer.ts tests/integration/csv-import.spec.ts
git commit -m "feat(csv-import): add pure importer (session + person match + attendance insert)"
```

---

### Task 4: Server Action wrapper

**Files:**
- Create: `lib/csv-import/actions.ts`

**Interfaces:**
- Consumes: `parseAttendeeCsv`, `isCsvFile` from `lib/csv-import/parser.ts` (Task 2); `createSessionFromCsvSchema`, `importAttendanceCsv` from `lib/csv-import/importer.ts` (Task 3); `requireAdmin` from `lib/auth/require-admin.ts`.
- Produces: `CreateSessionFromCsvResult` (`{ success: boolean; message: string; sessionId?: string }`), `createSessionFromCsv(formData: FormData): Promise<CreateSessionFromCsvResult>` — the only function Task 5's UI calls.

No new automated test in this task — this is a thin composition of two already-tested pieces plus `requireAdmin()`, which (like every other file under `lib/attendance/actions.ts` and `lib/xlsx/uploader.ts`) isn't directly tested in this codebase since it needs a real authenticated request context. Verified manually in Task 5's smoke-test step instead.

- [ ] **Step 1: Write the action**

```ts
// lib/csv-import/actions.ts
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
    const detail = rowErrors.map((e) => `row ${e.row}: ${e.message}`).join("; ");
    return { success: false, message: `${rowErrors.length} row(s) failed: ${detail}` };
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
```

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/csv-import/actions.ts
git commit -m "feat(csv-import): add createSessionFromCsv Server Action"
```

---

### Task 5: UI — `/sessions/import` page, `CsvImporter` component, source-label updates, nav link

**Files:**
- Create: `app/sessions/import/page.tsx`
- Create: `components/attendance/csv-importer.tsx`
- Modify: `lib/attendance/queries.ts` (the `AttendanceRow["source"]` union)
- Modify: `components/attendance/attendance-screen.tsx` (the `SOURCE_LABEL` map)
- Modify: `app/sessions/page.tsx` (add the new nav link; relabel the existing one)

**Interfaces:**
- Consumes: `createSessionFromCsv` from `lib/csv-import/actions.ts` (Task 4).

- [ ] **Step 1: Widen the `AttendanceRow["source"]` union**

In `lib/attendance/queries.ts`, find:

```ts
  source: "signup_sync" | "manual_tick" | "walk_in";
```

Replace with:

```ts
  source: "signup_sync" | "manual_tick" | "walk_in" | "csv_import";
```

- [ ] **Step 2: Add the CSV-import label**

In `components/attendance/attendance-screen.tsx`, find:

```ts
const SOURCE_LABEL: Record<AttendanceRow["source"], string> = {
  signup_sync: "eActivities",
  manual_tick: "Added",
  walk_in: "Walk-in",
};
```

Replace with:

```ts
const SOURCE_LABEL: Record<AttendanceRow["source"], string> = {
  signup_sync: "eActivities",
  manual_tick: "Added",
  walk_in: "Walk-in",
  csv_import: "CSV import",
};
```

- [ ] **Step 3: Run typecheck to confirm the union change is consistent everywhere**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS. (If any other file switches on `AttendanceRow["source"]` exhaustively, TypeScript will now flag a missing case — fix it there using the same `"csv_import"` string before moving on.)

- [ ] **Step 4: Write the `CsvImporter` component**

```tsx
// components/attendance/csv-importer.tsx
"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSessionFromCsv } from "@/lib/csv-import/actions";

export function CsvImporter() {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CSV file.");
      return;
    }

    const formData = new FormData(e.currentTarget);
    // <input type="datetime-local"> has no timezone -- convert to a real
    // ISO instant (in the browser's local timezone) before sending, same
    // conversion components/attendance/session-picker.tsx already does.
    const startsAtRaw = String(formData.get("startsAt") ?? "");
    formData.set("startsAt", startsAtRaw ? new Date(startsAtRaw).toISOString() : "");

    setIsPending(true);
    try {
      const result = await createSessionFromCsv(formData);
      if (result.success && result.sessionId) {
        toast.success(result.message);
        router.push(`/sessions/${result.sessionId}`);
      } else {
        setError(result.message);
      }
    } catch {
      setError("Import failed unexpectedly.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="title">Session title</Label>
        <Input id="title" name="title" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="startsAt">Starts at</Label>
        <Input id="startsAt" name="startsAt" type="datetime-local" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="file">Attendee CSV (exported from eActivities' dashboard)</Label>
        <input
          ref={fileInputRef}
          id="file"
          name="file"
          type="file"
          accept=".csv"
          required
          className="text-sm"
        />
      </div>
      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Importing…" : "Create session"}
      </Button>
      {error && <p className="text-sm text-destructive whitespace-pre-line">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 5: Write the `/sessions/import` page**

```tsx
// app/sessions/import/page.tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { CsvImporter } from "@/components/attendance/csv-importer";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

export default async function ImportSessionPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/sessions" className="text-sm text-muted-foreground underline">
        ← All sessions
      </Link>
      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New session (CSV import)</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fail-safe for when eActivities&apos; whatson/signups API is down — upload
            the attendee roster exported from eActivities&apos; own dashboard instead.
          </p>
        </div>
        <SignOutButton />
      </div>
      <div className="mt-8">
        <CsvImporter />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Link both session-creation paths from `/sessions`, and relabel the existing one**

In `app/sessions/page.tsx`, find:

```tsx
          <Button asChild variant="outline">
            <Link href="/sessions/new">New session</Link>
          </Button>
```

Replace with:

```tsx
          <Button asChild variant="outline">
            <Link href="/sessions/new">New session (eActivities)</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/sessions/import">New session (CSV import)</Link>
          </Button>
```

- [ ] **Step 7: Add the new route to the admin-gating e2e test**

In `tests/e2e/admin-auth-gate.spec.ts`, find:

```ts
  for (const path of ["/", "/sessions", "/sessions/new", "/admin/purchases", "/admin/chase-inbox", "/admin/unpaid"]) {
```

Replace with:

```ts
  for (const path of ["/", "/sessions", "/sessions/new", "/sessions/import", "/admin/purchases", "/admin/chase-inbox", "/admin/unpaid"]) {
```

- [ ] **Step 8: Run the full test suite**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm run test:integration && npm run test:e2e`
Expected: typecheck and lint clean; all integration tests pass (including the new `csv-import.spec.ts` from Task 3); all e2e tests pass (including the newly-added `/sessions/import` gating case).

- [ ] **Step 9: Manual smoke test**

Run: `npm run dev`, sign in as an admin, go to `/sessions/import`, fill in a title and start time, upload a small real or hand-written CSV with `First Name,Surname,Email` columns (and optionally `CID/Card Number`, `Date`, etc.), submit. Confirm: redirected to the new session's attendance screen, every uploaded row appears with source badge "CSV import" and unticked (not attended), and ticking one behaves exactly like it does for any other session (this part of the attendance screen is unchanged — confirms the new source value didn't break existing rendering/toggle logic).

- [ ] **Step 10: Commit**

```bash
git add app/sessions/import/page.tsx components/attendance/csv-importer.tsx \
  lib/attendance/queries.ts components/attendance/attendance-screen.tsx \
  app/sessions/page.tsx tests/e2e/admin-auth-gate.spec.ts
git commit -m "feat(csv-import): add /sessions/import page, CSV-import source label, nav link"
```
