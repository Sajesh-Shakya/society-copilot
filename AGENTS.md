<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
# Society Ops Copilot — Agent Instructions

## Product
This is a hackathon MVP for Society Ops Copilot.

## MVP scope
Support only:
1. Trip workflow generation
2. Payment reminder generation
3. Approval simulation with audit log

## Non-goals
- No real external integrations
- No real message sending
- No production auth unless explicitly requested
- No multi-page admin dashboard

## Technical rules
- Use Next.js App Router with TypeScript
- Use shadcn/ui for UI primitives
- Validate all LLM outputs with Zod
- Keep business logic separate from UI components
- Prefer mock data over incomplete integrations
- Add Playwright tests for the main happy path

## UI constraints
- The app must be a single-page interface
- No routing or multiple pages unless explicitly requested
- Output should be rendered as cards on the same screen

## Output requirements
- LLM responses must be parsed into structured JSON
- Show output as cards: risk assessment, proposal, checklist, missing requirements, payment reminders
- Approval button changes state and appends to audit log

## Output schema (strict)
All model responses MUST conform to this structure:

- workflowType: string
- riskAssessment: object
- activityProposal: object
- budget: object
- missingRequirements: string[]
- paymentReminders: { memberName: string, message: string }[]
- approvalState: "pending" | "approved"
- auditLog: { action: string, timestamp: string }[]

Do not return free text. Always return valid JSON.

## Development workflow
- Implement features incrementally
- Do not build the entire app at once
- Focus on one feature per task:
  - layout
  - schema
  - rendering
  - approval logic

## Scope Amendment: Attendance & Payment Chasing
This amendment applies only to the attendance tracking & payment chasing feature
(see `specs/attendance-payment-chasing/`). For this feature only, it supersedes
the MVP's single-page and mock-data constraints above. All other features remain
bound by the original constraints unmodified.

For this feature only:
- Real member data may be used (the "prefer mock data" rule does not apply here).
- Multiple views/pages are permitted (the single-page-interface constraint does
  not apply here).
- Scheduled background jobs are permitted (e.g. recurring payment-chase runs).

Everything else still applies to this feature unless a future amendment states
otherwise: human approval before any send, Zod validation of LLM outputs, no real
message sending unless explicitly built and approved, no production auth unless
explicitly requested, and full audit logging.