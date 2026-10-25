import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  importAttendanceCsv,
  syncAttendanceCsv,
  createSessionFromCsvSchema,
} from "@/lib/csv-import/importer";
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

  test("stores rawCidOrCardNumber on the attendance_record for audit (zero-padded)", async () => {
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

  test("matches an existing person by CID even when the row's email is different, instead of crashing on the unique CID index", async () => {
    const existingEmail = `csv-import-cid-collision-${crypto.randomUUID()}@example.test`;
    const cid = String(Math.floor(10_000_000 + Math.random() * 80_000_000));
    const { data: existing, error } = await admin
      .from("person")
      .insert({ full_name: "Existing CID Person", email: existingEmail, cid })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(existing.id);

    // Same real person, but this row carries a DIFFERENT email (e.g. they
    // signed up again under a second address) -- email-only matching
    // would find no match and try to INSERT a new person with this CID,
    // which person_cid_unique_idx rejects (two people can't share a real
    // CID). CID-first matching finds the existing person before that
    // ever happens.
    const result = await importAttendanceCsv({
      title: "CSV Import CID Collision Test",
      startsAt: "2026-10-15T18:00:00.000Z",
      rows: [row({ email: `a-completely-different-email-${crypto.randomUUID()}@example.test`, rawCidOrCardNumber: cid })],
    });
    sessionIds.push(result.sessionId);

    const { count: personCount } = await admin
      .from("person")
      .select("id", { count: "exact", head: true })
      .eq("cid", cid);
    expect(personCount).toBe(1); // no duplicate created

    const { data: record } = await admin
      .from("attendance_record")
      .select("person_id")
      .eq("session_id", result.sessionId)
      .single();
    expect(record!.person_id).toBe(existing.id);

    // The existing person's own email/full_name must be untouched -- the
    // row's differing email is evidence, not grounds to overwrite it.
    const { data: unchangedPerson } = await admin
      .from("person")
      .select("email, full_name")
      .eq("id", existing.id)
      .single();
    expect(unchangedPerson!.email).toBe(existingEmail);
    expect(unchangedPerson!.full_name).toBe("Existing CID Person");
  });

  test("a duplicate email within the same file (bypassing the parser's guard) still throws a comprehensible DB error", async () => {
    const email = `csv-import-dup-${crypto.randomUUID()}@example.test`;
    // The real createSessionFromCsv action path now rejects a duplicate
    // email at the parser layer (parseAttendeeCsv) before it ever reaches
    // importAttendanceCsv -- see the "duplicate email" case in
    // tests/unit/csv-import-parser.spec.ts. But importAttendanceCsv itself
    // is exported and callable directly (e.g. by a future caller that
    // builds AttendeeRow[] some other way), and it still has no duplicate
    // guard of its own, so it still throws the raw Postgres/PostgREST
    // unique-violation error object (the same "if (error) throw error"
    // convention lib/attendance/actions.ts uses), not a `new Error(...)`
    // instance, so Playwright/Jest's `.rejects.toThrow()` -- which only
    // recognizes a real Error instance -- reports "did not throw" here
    // even though a rejection did occur. Asserting on the rejected value's
    // `message` property directly matches what actually gets thrown
    // without changing that production behavior.
    await expect(
      importAttendanceCsv({
        title: "CSV Import Duplicate Test",
        startsAt: "2026-10-15T18:00:00.000Z",
        rows: [row({ email }), row({ email })],
      })
    ).rejects.toMatchObject({ message: expect.stringMatching(/duplicate/i) });

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

test.describe("syncAttendanceCsv", () => {
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

  async function newSession(): Promise<string> {
    const { data, error } = await admin
      .from("session")
      .insert({ title: "Sync CSV Test Session", starts_at: "2026-10-15T18:00:00.000Z" })
      .select("id")
      .single();
    if (error) throw error;
    sessionIds.push(data.id);
    return data.id;
  }

  test("adds new people to an existing session's roster, source csv_import, attended false", async () => {
    const sessionId = await newSession();
    const rows = [row(), row()];
    const result = await syncAttendanceCsv({ sessionId, rows });
    expect(result).toEqual({ added: 2, skipped: 0, removed: 0 });

    const { data: records } = await admin
      .from("attendance_record")
      .select("source, attended, person_id")
      .eq("session_id", sessionId);
    expect(records).toHaveLength(2);
    for (const record of records!) {
      expect(record.source).toBe("csv_import");
      expect(record.attended).toBe(false);
      personIds.push(record.person_id);
    }
  });

  test("skips a row whose person already has an attendance_record for this session, without touching it", async () => {
    const sessionId = await newSession();
    const email = `csv-sync-existing-${crypto.randomUUID()}@example.test`;

    const { data: person, error: personError } = await admin
      .from("person")
      .insert({ full_name: "Already There", email })
      .select("id")
      .single();
    if (personError) throw personError;
    personIds.push(person.id);

    const { error: recordError } = await admin.from("attendance_record").insert({
      person_id: person.id,
      session_id: sessionId,
      source: "manual_tick",
      attended: true,
    });
    if (recordError) throw recordError;

    const result = await syncAttendanceCsv({
      sessionId,
      rows: [row({ email }), row()],
    });
    expect(result).toEqual({ added: 1, skipped: 1, removed: 0 });

    // The pre-existing record must be untouched -- still manual_tick/attended:true,
    // not overwritten to csv_import/attended:false.
    const { data: existingRecord } = await admin
      .from("attendance_record")
      .select("source, attended")
      .eq("session_id", sessionId)
      .eq("person_id", person.id)
      .single();
    expect(existingRecord!.source).toBe("manual_tick");
    expect(existingRecord!.attended).toBe(true);

    const { data: allRecords } = await admin
      .from("attendance_record")
      .select("person_id")
      .eq("session_id", sessionId);
    for (const r of allRecords!) {
      if (r.person_id !== person.id) personIds.push(r.person_id);
    }
  });

  test("reuses an existing person matched by email instead of creating a duplicate", async () => {
    const sessionId = await newSession();
    const email = `csv-sync-reuse-${crypto.randomUUID()}@example.test`;
    const { data: existing, error } = await admin
      .from("person")
      .insert({ full_name: "Existing Person", email })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(existing.id);

    await syncAttendanceCsv({ sessionId, rows: [row({ email })] });

    const { count: personCount } = await admin
      .from("person")
      .select("id", { count: "exact", head: true })
      .ilike("email", email);
    expect(personCount).toBe(1);
  });

  test("removes a not-yet-attended csv_import row whose person has dropped off the new list", async () => {
    const sessionId = await newSession();
    const stayingEmail = `csv-sync-staying-${crypto.randomUUID()}@example.test`;
    const leavingEmail = `csv-sync-leaving-${crypto.randomUUID()}@example.test`;

    // First upload: both sign up.
    const first = await syncAttendanceCsv({
      sessionId,
      rows: [row({ email: stayingEmail }), row({ email: leavingEmail })],
    });
    expect(first).toEqual({ added: 2, skipped: 0, removed: 0 });

    const { data: staying } = await admin
      .from("person")
      .select("id")
      .ilike("email", stayingEmail)
      .single();
    const { data: leaving } = await admin
      .from("person")
      .select("id")
      .ilike("email", leavingEmail)
      .single();
    personIds.push(staying!.id, leaving!.id);

    // Second upload: only the staying person is still signed up.
    const second = await syncAttendanceCsv({
      sessionId,
      rows: [row({ email: stayingEmail })],
    });
    expect(second).toEqual({ added: 0, skipped: 1, removed: 1 });

    const { data: remaining } = await admin
      .from("attendance_record")
      .select("person_id")
      .eq("session_id", sessionId);
    expect(remaining!.map((r) => r.person_id)).toEqual([staying!.id]);
  });

  test("never removes a manual_tick or walk_in row, even if absent from the new upload", async () => {
    const sessionId = await newSession();
    const manualEmail = `csv-sync-manual-${crypto.randomUUID()}@example.test`;
    const walkInEmail = `csv-sync-walkin-${crypto.randomUUID()}@example.test`;

    const { data: manualPerson, error: manualError } = await admin
      .from("person")
      .insert({ full_name: "Manually Added", email: manualEmail })
      .select("id")
      .single();
    if (manualError) throw manualError;
    personIds.push(manualPerson.id);
    await admin.from("attendance_record").insert({
      person_id: manualPerson.id,
      session_id: sessionId,
      source: "manual_tick",
      attended: false,
    });

    const { data: walkInPerson, error: walkInError } = await admin
      .from("person")
      .insert({ full_name: "Walk In", email: walkInEmail })
      .select("id")
      .single();
    if (walkInError) throw walkInError;
    personIds.push(walkInPerson.id);
    await admin.from("attendance_record").insert({
      person_id: walkInPerson.id,
      session_id: sessionId,
      source: "walk_in",
      attended: true,
    });

    // Upload a CSV that mentions neither of them.
    const result = await syncAttendanceCsv({ sessionId, rows: [row()] });
    expect(result.removed).toBe(0);
    personIds.push(
      ...(
        await admin.from("attendance_record").select("person_id").eq("session_id", sessionId)
      ).data!.map((r) => r.person_id).filter((id) => id !== manualPerson.id && id !== walkInPerson.id)
    );

    const { data: stillThere } = await admin
      .from("attendance_record")
      .select("person_id, source")
      .eq("session_id", sessionId)
      .in("person_id", [manualPerson.id, walkInPerson.id]);
    expect(stillThere).toHaveLength(2);
  });

  test("never removes an already-attended csv_import row, even if absent from the new upload", async () => {
    const sessionId = await newSession();
    const email = `csv-sync-attended-${crypto.randomUUID()}@example.test`;

    const { data: person, error: personError } = await admin
      .from("person")
      .insert({ full_name: "Already Attended", email })
      .select("id")
      .single();
    if (personError) throw personError;
    personIds.push(person.id);
    await admin.from("attendance_record").insert({
      person_id: person.id,
      session_id: sessionId,
      source: "csv_import",
      attended: true,
    });

    const result = await syncAttendanceCsv({ sessionId, rows: [row()] });
    expect(result.removed).toBe(0);
    personIds.push(
      ...(
        await admin.from("attendance_record").select("person_id").eq("session_id", sessionId)
      ).data!.map((r) => r.person_id).filter((id) => id !== person.id)
    );

    const { data: stillThere } = await admin
      .from("attendance_record")
      .select("id")
      .eq("session_id", sessionId)
      .eq("person_id", person.id);
    expect(stillThere).toHaveLength(1);
  });
});
