<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
# AGENTS.md

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

## Output requirements
- LLM responses must be parsed into structured JSON
- Show output as cards: risk assessment, proposal, checklist, missing requirements, payment reminders
- Approval button changes state and appends to audit log