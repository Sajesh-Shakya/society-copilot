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
        // Zero-padded to 8 digits -- see normalizeCid in lib/utils.ts.
        // The real CID/Card Number column observed in practice is 7
        // digits with the leading zero already dropped (just like an
        // Excel numeric cell loses it), and real Imperial CIDs are 8.
        rawCidOrCardNumber: "02577809",
      },
      {
        firstName: "Abbas",
        surname: "Azani",
        email: "abbas.azani26@imperial.ac.uk",
        rawCidOrCardNumber: "02798711",
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

  test("reports a duplicate email within the same file, case-insensitively, without importing the second row", () => {
    const csv = `First Name,Surname,Email
Aaron,Garcia,Aaron@x.com
Aaron,Imposter,aaron@x.com`;
    const result = parseAttendeeCsv(csvBuffer(csv));
    expect(result.rows).toEqual([
      { firstName: "Aaron", surname: "Garcia", email: "Aaron@x.com", rawCidOrCardNumber: null },
    ]);
    expect(result.rowErrors).toEqual([{ row: 2, message: 'duplicate email "aaron@x.com"' }]);
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
