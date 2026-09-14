# Society Ops Copilot Workflows

## Workflow design standard
Each workflow should be implemented as:
- a trigger
- a structured input payload
- one or more validation steps
- a draft generation step
- an approval step
- a completion step
- an audit log entry at each state transition

## 1. Payment Chaser
### Purpose
Chase members who have not paid, not bought the correct product, not completed a signup, or not confirmed attendance.

### Trigger
- scheduled batch
- manual run by committee member
- product / signup mismatch detected

### Inputs
- society identifier
- relevant product(s)
- relevant signup(s)
- event / trip context
- chasing channel preference
- message tone / urgency

### Data dependencies
- committee members
- members
- products
- product sales
- signups
- event metadata

### Steps
1. Pull member, product, sale, and signup data.
2. Build an eligibility / missing-action list.
3. Split members into chase groups.
4. Draft message batch per group.
5. Present batch to committee user.
6. User approves, edits, or cancels.
7. Log outcome and update task status.

### Outputs
- recipient groups
- draft messages
- CSV / JSON batch export
- chase task audit entry

### Approval gate
Human approval required before any outbound send.

### Notes
Do not auto-send by default. Messaging must support opt-out and edit-before-send.

## 2. ICU Correspondence Agent
### Purpose
Draft emails or support tickets to ICU Activities or related teams.

### Trigger
- committee member asks a question
- workflow detects blocker or missing policy clarification
- room booking / event / finance edge case needs staff support

### Inputs
- issue category
- urgency
- society details
- prior correspondence, if any
- supporting docs or links

### Data dependencies
- workflow context
- prior drafts / messages
- policy snippets
- committee contact info

### Steps
1. Classify the issue.
2. Fetch the relevant policy context.
3. Ask for missing details if required.
4. Draft the email or ticket.
5. Present for review.
6. User approves and sends manually or via integrated channel.
7. Save reference number / ticket ID if available.

### Outputs
- ticket subject
- ticket body
- attachments checklist
- next action reminder

### Approval gate
Always required.

## 3. Activity Proposal Drafting
### Purpose
Generate a first draft of activity or trip proposal answers.

### Trigger
- committee starts a new event/trip
- room booking or funding workflow requires proposal info

### Inputs
- activity name
- dates
- location
- purpose
- attendee estimates
- whether tickets are sold
- whether activity is in core RA

### Data dependencies
- previous proposal templates
- prior RA examples
- event budget summary
- room or venue details

### Steps
1. Determine whether a proposal is likely required.
2. Gather prerequisites.
3. Generate structured draft fields.
4. Flag missing evidence or blockers.
5. Send to approval queue.

### Outputs
- proposal answers
- missing prerequisites list
- attachments checklist

### Approval gate
Human must verify accuracy before submission.

## 4. Risk Assessment Drafting
### Purpose
Generate first-pass event/trip risk assessments from templates and structured event data.

### Trigger
- new event/trip created
- proposal workflow indicates RA required
- annual review due

### Inputs
- activity description
- dates
- venue/location
- attendee type
- travel mode
- specialist training details
- responsible persons

### Data dependencies
- prior RA templates
- hazard library
- previous BUCS / Warwick-style examples

### Steps
1. Select template family.
2. Populate fixed metadata.
3. Select likely hazards.
4. Draft controls, further controls, responsible persons, and emergency actions.
5. Highlight fields still requiring manual verification.
6. Move to approval.

### Outputs
- structured RA JSON
- printable RA draft
- unresolved verification checklist

### Approval gate
Human review required. Safety-critical content must never be auto-submitted.

## 5. Room Booking Drafting
### Purpose
Draft annual or ad hoc room booking requests and justifications.

### Trigger
- annual booking season opens
- user initiates ad hoc booking
- workflow detects recurring activity without room allocation

### Inputs
- activity type
- preferred time slots
- preferred rooms
- justification
- whether activity is in core RA
- equipment / accessibility requirements

### Data dependencies
- room policy rules
- prior booking justifications
- event / activity proposal context
- calendar availability snapshot if integrated

### Steps
1. Determine annual vs ad hoc path.
2. Validate minimum notice and policy preconditions.
3. Draft request and justification.
4. Attach evidence / supporting rationale.
5. Require approval.
6. Record booking outcome when known.

### Outputs
- booking request draft
- rationale block
- policy warnings
- deadline reminder

### Approval gate
Always required before submission.

## 6. Funding Application Drafting
### Purpose
Draft ADF / Trips Fund applications from structured facts and policy rules.

### Trigger
- relevant round opens
- committee starts funding workflow
- event/trip requires supplementary funding

### Inputs
- funding scheme
- project / trip summary
- budget lines
- member counts
- outcomes / rationale
- existing support / grant info

### Data dependencies
- policy rules
- round deadlines
- proposal/trip IDs
- event/trip budget summary

### Steps
1. Validate eligibility against scheme rules.
2. Check deadlines and prerequisites.
3. Build structured funding narrative.
4. Draft justification and budget rationale.
5. Flag missing or non-compliant items.
6. Move to approval.

### Outputs
- draft form answers
- eligibility warnings
- attachments checklist
- submission-readiness status

### Approval gate
Treasurer or delegated approver required.

## 7. Finance Admin Assistant
### Purpose
Support claims, purchase orders, invoice readiness, and goods receipting reminders.

### Trigger
- user enters purchase context
- transaction lines show pending items
- scheduled follow-up for coaching fees or invoices

### Inputs
- supplier
- amount
- VAT info
- category
- receipt/invoice status
- whether under/over threshold

### Data dependencies
- transaction lines
- prior supplier records
- internal finance guidance

### Steps
1. Classify claim vs purchase order.
2. Check required evidence.
3. Draft submission notes or reminders.
4. Queue for approver review if needed.

### Outputs
- finance submission checklist
- draft description fields
- goods receipting reminder task

### Approval gate
Human required for all spend-related actions.

## 8. Attendance Tracking & Payment Chasing
### Purpose
Track per-session attendance against eActivities sign-ups and derive
outstanding payment debt from unpaid, unwaived attendance, then chase members
who owe for sessions attended without a covering purchase.

### Trigger
- admin opens the attendance screen for a session
- scheduled sync ~1 hour before a session's start time
- scheduled debt-age check (draft a chase email once debt has been
  outstanding for more than the configured number of days)

### Inputs
- session identifier
- eActivities sign-up list for that session
- Pluto / XLSX purchase and membership data
- exemption flags

### Data dependencies
- eActivities signups (via `SocietyDataProvider`)
- Pluto API or XLSX purchase uploads
- the `person` / `attendance_record` / `product` / `purchase` ledger in
  `specs/attendance-payment-chasing/design.md`

### Steps
1. Sync eActivities sign-ups into `attendance_record` rows for the session.
2. Admin ticks attendance in real time; changes sync across concurrent admin
   sessions (Supabase Realtime).
3. Ingest purchases/memberships from Pluto or an uploaded XLSX file and match
   them to `person` records (CID-first, email fallback, manual review as last
   resort).
4. Derive outstanding debt per person as a query over unwaived attendance.
5. Draft a chase email once debt has been outstanding past the configured
   threshold, unless the person is flagged exempt.
6. Present first-in-cycle chase emails in the approval inbox; repeat
   reminders may auto-send under a configured policy.
7. Log every send and every approval decision to the audit trail.

### Outputs
- per-session attendance ledger
- derived per-person debt
- draft / approved / sent chase emails
- manual-review queue for unmatched purchases

### Approval gate
The first chase email in a debt cycle always requires explicit admin
approval. Repeat reminders may follow a configurable auto-send policy once
enabled for that cycle. Exact thresholds and exemption authority are still
open — see "Open Questions" in `specs/attendance-payment-chasing/design.md`.

### Notes
This workflow uses real member data, multiple views, and scheduled
background jobs, per the "Scope Amendment: Attendance & Payment Chasing"
section of `AGENTS.md`, which supersedes the MVP's single-page/mock-data
constraints for this workflow only. Full requirements:
`specs/attendance-payment-chasing/requirements.md`.

## State machine
All workflows should share a common lifecycle:
- `draft_requested`
- `data_gathering`
- `awaiting_missing_inputs`
- `draft_ready`
- `awaiting_approval`
- `approved`
- `rejected`
- `submitted_or_sent`
- `completed`
- `cancelled`

`chase_email.status` (`draft` / `pending_approval` / `approved` / `sent` /
`cancelled`) is Attendance Tracking & Payment Chasing's specialization of the
lifecycle above: `draft_requested`/`data_gathering` collapse into `draft`,
`draft_ready`/`awaiting_approval` collapse into `pending_approval`, and
`submitted_or_sent`/`completed` collapse into `sent`.
