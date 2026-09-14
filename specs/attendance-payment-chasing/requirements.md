# Attendance Tracking & Payment Chasing — Requirements

EARS-format requirements only. Requirement IDs (`AC-#`, `MP-#`, `DC-#`) exist so
`tasks.md` can trace each implementation task back to the requirement(s) it
satisfies.

## Attendance Capture

- **AC-1.** WHEN an admin opens the attendance screen for a session, THE system
  SHALL display the eActivities sign-up list for that session, with each row
  togglable as attended/not-attended.
- **AC-2.** WHEN an admin toggles a person's attendance status, THE system SHALL
  persist the change idempotently such that repeated identical toggles produce
  no duplicate records.
- **AC-3.** WHEN two or more admins have the attendance screen open for the same
  session, THE system SHALL propagate toggle changes to all open sessions within
  2 seconds, so admins dividing a room know which names are already covered.
- **AC-4.** WHEN an admin searches for a name not present in the current sign-up
  list, THE system SHALL suggest existing person records with similar names
  (fuzzy match) before allowing creation of a new record.
- **AC-5.** IF no similar existing record is found, THEN THE system SHALL allow
  the admin to create a new person record via a walk-in form requiring a
  directly-supplied email address (mandatory), with an optional shortcode field.
- **AC-6.** WHEN an admin manually triggers a sync/refresh, THE system SHALL
  re-fetch the eActivities sign-up list and merge new sign-ups without
  duplicating or losing existing ticks.
- **AC-7.** THE system SHALL also trigger a sync automatically approximately 1
  hour before a session's start time.

## Membership & Purchases

- **MP-1.** WHEN a person holds an active term or annual pass, THE system SHALL
  NOT count their session attendance toward outstanding debt, but SHALL continue
  recording attendance for historical/usage reporting.
- **MP-2.** WHEN a person's term or annual pass expires, THE system SHALL resume
  counting subsequent attendance toward debt from the expiry date forward.
- **MP-3.** WHEN a person purchases a pass or membership that covers prior
  unpaid attendance, THE system SHALL mark those historical attendance records
  as waived by that purchase, and SHALL NOT delete them.
- **MP-4.** THE system SHALL support ingesting purchase/sale data from the Pluto
  API (SUMS Digital) when available, and from a manually uploaded XLSX file as a
  fallback, via the same internal purchase-ingestion interface.
- **MP-5.** THE system SHALL ingest the `Member Type` field from Pluto/XLSX
  purchase rows where present, and SHALL derive a binary `is_student` flag from
  it: `is_student = true` only when the raw value exactly matches the Student
  category; every other observed or future value (Public, Associate, Staff, or
  any unrecognized category) SHALL default to `is_student = false`.
- **MP-6.** WHEN the same purchase record is ingested more than once (e.g.
  re-uploaded file, re-run poll), THE system SHALL NOT create duplicate
  purchase records.

## Debt & Chasing

- **DC-1.** THE system SHALL derive, not store as a mutable field, the number
  of unpaid sessions owed per person, computed from attendance records not yet
  covered by a purchase or waiver.
- **DC-2.** WHEN a person's outstanding debt is greater than zero for more than
  N days (configurable), THE system SHALL generate a draft chase email.
- **DC-3.** WHEN a chase email is the first one generated for a person in a
  debt cycle, THE system SHALL require explicit admin approval before sending.
- **DC-4.** WHEN a chase email is a repeat reminder in an already-approved
  sequence, THE system MAY auto-send under an admin-configured policy, and
  SHALL log every send to the audit trail.
- **DC-5.** IF a person is flagged exempt (e.g. committee member, known offline
  payer), THEN THE system SHALL NOT generate chase emails for them.
- **DC-6.** WHEN a person's debt reaches zero, THE system SHALL stop generating
  further chase emails for that debt cycle immediately.
