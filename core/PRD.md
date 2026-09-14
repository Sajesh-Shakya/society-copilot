# Society Ops Copilot PRD

## Product summary
Society Ops Copilot is an AI-assisted operations system for Imperial College Union clubs and societies. It reduces committee admin burden by drafting forms, preparing budgets, generating correspondence, tracking deadlines, and producing payment follow-up batches. Humans stay in control for approvals, spend, submissions, and sensitive outbound communication.

The product is not a general chatbot. It is a workflow-first copilot with structured inputs, reusable templates, approval gates, and a full audit trail.

## Problem
Small society committees repeatedly perform high-friction operational work:
- drafting room booking justifications
- preparing activity proposals, risk assessments, and budgets
- chasing members for payments, signups, and confirmations
- corresponding with ICU Activities through tickets and email
- applying for time-bound funding rounds
- coordinating trip logistics and compliance paperwork

This work is repetitive, deadline-sensitive, and usually spread across email, WhatsApp, SUMS, eActivities, Union forms, and policy pages. Most of it is too structured to justify full manual effort, but too risky to fully automate without approval.

## Product goal
Reduce time spent on society administration by 50% or more for common committee workflows while preserving compliance, auditability, and human approval over important actions.

## Target users
### Primary users
- society presidents/chairs
- treasurers
- secretaries
- activities officers / trip organisers

### Secondary users
- welfare officers
- equipment / merchandise managers
- future multi-society committee teams

## Jobs to be done
### President / Chair
- Draft annual and ad hoc room booking requests
- Draft tickets or emails to ICU Activities
- Coordinate trips and competitions
- Review and approve important outbound communication

### Treasurer
- Prepare event budgets and funding applications
- Track claims, purchase orders, and goods receipting tasks
- Reconcile product sales / signups / payments
- Approve spend-related drafts before submission

### Secretary
- Draft coach / admin forms
- Reply to inbound interest questions
- Chase attendance confirmations and missing information
- Manage message batches for WhatsApp and email

## Product principles
- Workflow-first, not chat-first
- Human approval before send, submit, or spend
- Structured outputs over freeform prose
- Policy-grounded suggestions
- Full audit trail for every draft and approval
- Modular integrations so eActivities can be used now and Pluto later

## Core workflows in scope
1. Payment chasing and attendance chasing
2. ICU correspondence and ticket drafting
3. Form drafting for activity proposals, risk assessments, and admin forms
4. Funding application drafting
5. Room booking drafting and deadline reminders

## MVP recommendation
### MVP name
Society Ops Copilot: Admin Core

### MVP scope
Ship only the workflows with the highest frequency and clearest value:
1. Payment Chaser
2. ICU Correspondence Agent
3. Form Drafting Agent

### Why this MVP
- immediate value to committee members
- low-risk because every message/form still requires approval
- strong demo for hackathons and pilots
- leverages existing eActivities data without needing write access

### MVP features
- import member, product, sale, and signup data from eActivities
- generate missing-payment / missing-signup / missing-confirmation batches
- draft WhatsApp or email messages for selected recipients
- draft Freshdesk / ICU ticket or email replies from a structured brief
- draft first-pass activity proposal / risk assessment / room booking justification from templates and prior examples
- approval inbox with approve / edit / reject actions
- audit log of data pulled, drafts created, prompts used, and approvals made

### MVP non-goals
- automatic form submission
- automatic payments / refunds / spend decisions
- autonomous WhatsApp sending by default
- full multi-society tenancy at first release
- replacing human judgment on safety, welfare, or policy edge cases

## Startup-grade product vision
### Phase 1: Admin Core
- payment chasing
- correspondence drafting
- room booking drafting
- proposal / RA drafting

### Phase 2: Compliance and funding
- ADF / Trips Fund drafting
- deadline and policy rules engine
- prerequisites checker
- reusable template library by society type

### Phase 3: Operating system for societies
- multi-society tenancy
- role-based approvals
- analytics on admin load, approval turnaround, and missed deadlines
- workflow marketplace for common society patterns

## Functional requirements
### Drafting
- The system must generate structured drafts from user input, templates, and policy context.
- The system must support output formats for email, WhatsApp, form answers, and JSON payloads.

### Approval
- The system must require explicit human approval before sending a message, submitting a form, or committing spend.
- The system must support edit-before-approve.

### Data ingestion
- The system must pull current committee, member, product, sales, signup, transaction, and event data from eActivities.
- The system must normalise external data into internal schemas.

### Workflow execution
- The system must track each task from draft to approval to completion.
- The system must record deadlines, blockers, and dependencies.

### Auditability
- The system must store who created, edited, approved, or rejected each draft.
- The system must preserve the source context used for each recommendation.

## Non-functional requirements
- secure secret handling
- low-friction manual review
- modular adapters for external systems
- deterministic JSON contracts at integration boundaries
- resilient fallback when a provider or source is unavailable

## Success metrics
### Time saving
- median time to prepare a payment chase batch
- median time to produce first draft of ticket / room booking / activity proposal

### Quality
- draft acceptance rate without major rewrite
- percentage of drafts approved after one edit or fewer

### Compliance
- missed-deadline rate
- number of submissions blocked correctly due to missing prerequisites

### Usage
- weekly active committee users
- workflows completed per week

## Risks
- source policies change
- forms change faster than templates are updated
- false confidence from AI-generated compliance text
- accidental data leakage if secrets are handled poorly
- over-automation of sensitive member communications

## Constraints
- eActivities is available now but appears read-oriented from the current API documentation
- Pluto should be treated as a future adapter target, not a dependency for MVP
- Union processes require human review for formal submissions and responsible use of systems

## Recommended system shape
Use a workflow engine with:
- adapters for external systems
- template-backed drafting
- rule checks before approval
- an approval inbox
- an append-only audit log

## Suggested tech stack
### Hackathon
- Next.js frontend
- FastAPI or Next.js API routes backend
- PostgreSQL / Supabase
- OpenRouter LLMs
- manual CSV / JSON import plus eActivities read adapter

### Startup-grade
- frontend: Next.js
- backend: FastAPI or NestJS
- queue: Celery / BullMQ
- database: PostgreSQL
- storage: S3-compatible object store for templates and submission artifacts
- auth: Clerk / Auth.js / SSO if available
- observability: structured logs + OpenTelemetry

## Demo story
A treasurer opens the app, sees that 9 members bought competition tickets but only 6 signed up and 3 have missing travel confirmations. The system drafts one WhatsApp batch, one email batch, and a ticket to ICU Activities asking about a room booking edge case. It also generates a room booking justification draft based on previous years. The committee member reviews, edits two lines, approves, and sends.
