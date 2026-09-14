# Society Ops Copilot Schemas

## Design notes
- Use strict JSON contracts between UI, workflow engine, and adapters.
- Keep external-system payloads separate from internal workflow schemas.
- Add `source_refs` and `audit` metadata to every persisted object.
- Attendance Tracking & Payment Chasing persists a relational schema
  (Postgres/Supabase) instead of the JSON documents below — see
  `specs/attendance-payment-chasing/design.md` for the full table
  definitions. Its `chase_email` table is a distinct, per-session-attendance
  chase path; `PaymentChaseCandidate` / `MessageBatchDraft` below remain the
  shape used by the original (signup/sale-mismatch based) Payment Chaser
  workflow.

## Common types
```json
{
  "AuditMeta": {
    "created_at": "2026-03-24T20:30:00Z",
    "created_by": "user_123",
    "source_refs": ["eactivities:CSP/170/reports/members?year=25-26"],
    "revision": 3
  }
}
```

## SocietyProfile
```json
{
  "society_id": "icu-judo",
  "display_name": "Imperial College Judo Society",
  "centre_code": "170",
  "committee_contacts": [
    {
      "role": "President",
      "name": "Sajesh Shakya",
      "email": "example@imperial.ac.uk"
    }
  ],
  "channels": {
    "email": true,
    "whatsapp": true,
    "freshdesk": true
  },
  "audit": {}
}
```

## WorkflowTask
```json
{
  "task_id": "wf_001",
  "workflow_type": "payment_chaser",
  "society_id": "icu-judo",
  "status": "awaiting_approval",
  "title": "Chase missing BUCS payments",
  "deadline": "2026-02-20",
  "owner_role": "Treasurer",
  "approver_roles": ["Treasurer", "President"],
  "input_ref_ids": ["sales_batch_2026_02_18"],
  "draft_ref_ids": ["msg_batch_004"],
  "blockers": [],
  "audit": {}
}
```

## ApprovalDecision
```json
{
  "approval_id": "appr_001",
  "task_id": "wf_001",
  "decision": "approved",
  "approved_by": "user_123",
  "approved_at": "2026-03-24T20:35:00Z",
  "comments": "Send after 6pm",
  "approved_revision": 2,
  "audit": {}
}
```

## PaymentChaseCandidate
```json
{
  "candidate_id": "pc_001",
  "member_name": "Jane Doe",
  "member_email": "jane@imperial.ac.uk",
  "channel_hint": "whatsapp",
  "issue_type": "missing_payment",
  "event_name": "BUCS 2026",
  "expected_product": "BUCS Competition Ticket",
  "found_sale": false,
  "found_signup": true,
  "notes": ["Signed up but no product sale found"],
  "audit": {}
}
```

## MessageBatchDraft
```json
{
  "batch_id": "msg_batch_004",
  "workflow_type": "payment_chaser",
  "channel": "whatsapp",
  "audience": ["pc_001", "pc_002"],
  "message_template": "Hi {first_name}, quick reminder to complete payment for {event_name}...",
  "rendered_messages": [
    {
      "recipient": "Jane Doe",
      "text": "Hi Jane, quick reminder to complete payment for BUCS 2026 before Friday."
    }
  ],
  "requires_approval": true,
  "audit": {}
}
```

## CorrespondenceDraft
```json
{
  "draft_id": "corr_009",
  "channel": "freshdesk_ticket",
  "subject": "Annual room booking clarification for Judo weekly sessions",
  "body": "Hello Activities Team, ...",
  "attachments": [
    {
      "kind": "supporting_note",
      "name": "room-booking-rationale.md"
    }
  ],
  "issue_category": "room_booking",
  "requires_approval": true,
  "audit": {}
}
```

## RoomBookingDraft
```json
{
  "booking_draft_id": "rb_001",
  "booking_type": "annual",
  "activity_name": "Weekly Judo Training",
  "preferred_slots": [
    {"day": "Wednesday", "start": "18:00", "end": "20:00"},
    {"day": "Sunday", "start": "12:00", "end": "14:00"}
  ],
  "preferred_spaces": ["Union Gym"],
  "justification": "Judo requires sprung flooring and co-location with tatami mats...",
  "policy_checks": {
    "core_ra_confirmed": true,
    "annual_booking_window_open": true,
    "needs_manual_verification": true
  },
  "requires_approval": true,
  "audit": {}
}
```

## ActivityProposalDraft
```json
{
  "proposal_id": "ap_003",
  "activity_name": "Warwick Invitational",
  "activity_type": "organised_sports_competition",
  "location": "University of Warwick, Coventry",
  "dates": {
    "start": "2026-02-14",
    "end": "2026-02-14"
  },
  "summary": "One-day university judo competition with public transport travel.",
  "proposal_answers": {
    "purpose": "Competitive development opportunity for members.",
    "travel": "Public transport coordinated by committee.",
    "ticketing": true
  },
  "required_attachments": ["risk_assessment", "budget"],
  "missing_fields": [],
  "requires_approval": true,
  "audit": {}
}
```

## RiskAssessmentDraft
```json
{
  "ra_id": "ra_010",
  "template_family": "external_competition_trip",
  "activity_name": "BUCS 2026",
  "location": "Walsall Campus, University of Wolverhampton",
  "dates": {
    "assessment_date": "2026-01-07",
    "activity_date": "2026-03-13"
  },
  "activity_description": "National university judo competition with overnight stay and coordinated travel.",
  "hazards": [
    {
      "code": "1.1",
      "name": "Slips, Trips or Falls",
      "controls": ["Set up mats correctly", "Monitor spillages"],
      "responsible_person": "Treasurer",
      "manual_verification_required": true
    }
  ],
  "emergency_actions": {
    "fire_procedure": "Check evacuation route and gather at assembly point.",
    "first_aider": "Glenn Spiers"
  },
  "requires_approval": true,
  "audit": {}
}
```

## FundingApplicationDraft
```json
{
  "funding_id": "fund_001",
  "scheme": "ADF",
  "round": "2025-26 Round 3",
  "project_title": "Tatami transport and equipment support",
  "eligibility_status": "needs_review",
  "budget_lines": [
    {
      "name": "Equipment",
      "amount_gbp": 250.0,
      "category": "capital"
    }
  ],
  "narrative": {
    "need": "Supports core activity delivery.",
    "impact": "Improves safety and participation."
  },
  "warnings": ["Check that item is eligible under current ADF rules"],
  "requires_approval": true,
  "audit": {}
}
```

## eActivitiesNormalizedSnapshot
```json
{
  "snapshot_id": "snap_2026_03_24",
  "centre_code": "170",
  "committee_members": [],
  "members": [],
  "products": [],
  "sales": [],
  "signups": [],
  "transaction_lines": [],
  "whatson_events": [],
  "audit": {}
}
```

## Attendance Tracking & Payment Chasing schema
This feature's persisted entities (`person`, `session`, `attendance_record`,
`product`, `purchase`, `sync_cursor`, `chase_email`) are relational tables, not
JSON documents, and are defined in full in
`specs/attendance-payment-chasing/design.md` rather than duplicated here.
