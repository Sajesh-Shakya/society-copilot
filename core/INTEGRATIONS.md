# Society Ops Copilot Integrations

## Integration strategy
Use a ports-and-adapters design.

Core workflow logic must depend on internal interfaces only. External systems should be wrapped behind adapters so the product can use eActivities now and add or replace with Pluto later without rewriting workflow logic.

## Integration layers
### 1. Workflow core
Responsibilities:
- task orchestration
- policy/rule checks
- prompt assembly
- approval state machine
- audit logging

### 2. Data adapters
Responsibilities:
- pull external data
- map external payloads to internal schemas
- expose consistent read methods

### 3. Channel adapters
Responsibilities:
- prepare outbound messages
- optionally send after approval
- return message/ticket identifiers

### 4. Document/template adapters
Responsibilities:
- load template families
- store generated drafts
- version templates and prompts

## eActivities adapter
### Why it matters
Current eActivities documentation provides practical read access to committee, membership, online sales, products, signups, transaction lines, profile entries, and What’s On events. That is enough for payment chasing, signup reconciliation, finance reminders, and event data hydration.

### Internal interface
```ts
interface SocietyDataProvider {
  getCommitteeMembers(societyId: string, year?: string): Promise<CommitteeMember[]>
  getMembers(societyId: string, year?: string): Promise<Member[]>
  getProducts(societyId: string, year?: string): Promise<Product[]>
  getProductSales(societyId: string, productId: string): Promise<ProductSale[]>
  getSignups(societyId: string): Promise<Signup[]>
  getTransactionLines(societyId: string, year?: string): Promise<TransactionLine[]>
  getEvents(societyId: string): Promise<Event[]>
}
```

### MVP use cases
- identify members with missing sales or signups
- build event context from products / signups / What’s On events
- create finance/admin reminders from transaction line patterns
- load current committee contacts for approvals and correspondence

### Limitations
- treat it as low-volume and read-oriented
- avoid aggressive polling
- assume write operations are unavailable or out of scope unless proven otherwise

## Pluto adapter
### Why it matters
Pluto is being rolled out progressively across parts of SUMS/web data. It should be treated as a future provider that may become richer or more suitable for some data domains.

**Update:** Attendance Tracking & Payment Chasing is the first feature to
implement `PlutoProvider` for real, scoped to purchase/sale ingestion (not
the full `SocietyDataProvider` surface yet). An XLSX manual-upload adapter
backs the same internal purchase-ingestion interface as a fallback when
Pluto access is unavailable. See `specs/attendance-payment-chasing/design.md`.

### Strategy
- define a `SocietyDataProvider` interface now
- implement `EactivitiesProvider` first
- implement `PlutoProvider` later for overlapping or new domains
- add a `CompositeProvider` if both sources are needed

### Migration plan
1. Preserve internal schemas.
2. Build Pluto adapter against the same interfaces.
3. Run both providers in shadow mode for overlapping datasets.
4. Compare outputs via integration tests.
5. Switch workflow feature flags gradually.

## Freshdesk / email correspondence adapter
### MVP
- no direct ticket submission required
- generate subject/body/attachment checklist
- allow manual copy-send

### Future
- optional ticket creation via API or email integration
- ticket status sync into workflow tasks

## Purchase-ingestion adapter
### Why it matters
Purchase/membership data can arrive from more than one source (Pluto API
now, potentially others later) or from a manually uploaded file when API
access isn't available. Ingestion logic (dedupe, `Member Type` →
`is_student` mapping, person matching) shouldn't be duplicated per source.

### Internal interface
```ts
interface PurchaseIngestionAdapter {
  ingest(input: PlutoPollResult | XlsxUploadFile): Promise<IngestedPurchase[]>
}
```

### MVP use case
Attendance Tracking & Payment Chasing uses this interface for both the Pluto
API poller and the XLSX upload path, so idempotency
(`UNIQUE(source, source_row_id)`) and identity matching are implemented once.
See `specs/attendance-payment-chasing/design.md`.

## Messaging adapters
### WhatsApp
MVP should support export or approval-ready text first. Direct sending can be deferred.

### Email
Support draft generation first. Direct send can be added only with approval and proper logging.

### Telegram / Slack
Useful for internal committee notifications rather than member-facing communication.

## Template storage
Recommended structure:
- `templates/room-bookings/annual/*.md`
- `templates/risk-assessments/external-trip/*.md`
- `templates/funding/adf/*.md`
- `templates/correspondence/activities-team/*.md`

Each template should include:
- required inputs
- optional inputs
- output schema
- policy notes
- version

## Recommended software patterns
### Ports and adapters
Keeps workflow logic independent from eActivities/Pluto/Freshdesk/WhatsApp.

### Realtime sync
Attendance Tracking & Payment Chasing needs multiple concurrent admin
sessions to see the same session's attendance ticks live. Use Supabase
Realtime (Postgres logical replication) scoped by `session_id`, not
application-level locking — see "Architecture Decisions" in
`specs/attendance-payment-chasing/design.md`.

### State machine
Needed for predictable task lifecycle and approvals.

### Repository pattern
Use repositories for internal entities such as tasks, drafts, approvals, audit logs.

### Strategy pattern
Useful for choosing different template families and generation approaches by workflow type.

### Rules engine
Use for deadlines, eligibility checks, and submission blockers.

### Event-driven notifications
Use queued reminders for deadlines, missing fields, and follow-ups.

## Suggested service breakdown
- `workflow-service`
- `policy-service`
- `draft-service`
- `approval-service`
- `audit-service`
- `integration-eactivities`
- `integration-pluto`
- `integration-messaging`
- `integration-correspondence`
- `attendance-service` (session attendance ledger, debt derivation,
  chase-email generation for Attendance Tracking & Payment Chasing)
- `integration-realtime` (Supabase Realtime fan-out for multi-admin
  attendance sync)

## Suggested repo structure
```text
apps/
  web/
  api/
packages/
  domain/
  workflows/
  adapters-eactivities/
  adapters-pluto/
  adapters-messaging/
  adapters-purchase-ingestion/
  templates/
  rules/
  schemas/
  prompts/
  evals/
  jobs/                    # scheduled background jobs (sign-up sync, debt-age chase generation)
```
