# Society Ops Copilot Rules

## 1. Product boundary rules
- The system is an operations copilot, not a general chatbot.
- The system drafts, checks, reminds, and escalates.
- The system must not silently submit forms, commit spend, or send sensitive outbound messages.

## 2. Human approval rules
Human approval is mandatory before:
- sending WhatsApp, email, or staff-facing ticket content
- submitting a room booking request
- submitting an activity proposal or risk assessment
- applying for funding
- recording or initiating any spend-related operation

Human approval should capture:
- approver identity
- timestamp
- approved version hash or revision number
- optional approval note

## 3. Data handling rules
- External data must be normalised into internal schemas before workflow logic runs.
- Raw external payloads must be retained for audit/debugging, but secrets must never be logged.
- API keys, passwords, and supplier credentials must not be stored in prompts or markdown templates.
- Personally identifiable information should only be shown when relevant to the current task.

## 4. Prompting rules
- Prompts must request structured output whenever a workflow feeds another system.
- Forms and risk assessments should be generated from template-backed prompts, not open-ended chat prompts.
- The model must be asked to list unresolved assumptions explicitly.
- The model must distinguish between facts from source data and inferred wording.

## 5. Policy and compliance rules
- The system should prefer official Union and SUMS guidance over committee folklore when they conflict.
- If policy confidence is low, the workflow should recommend contacting ICU Activities rather than guessing.
- Deadline-sensitive workflows must surface the deadline at the top of the task card.
- The system must not advise spending or booking ahead of required approvals.

## 6. Room booking rules
### Annual bookings
- Treat annual bookings as regular weekly bookings tied to core or low-risk activity.
- Annual bookings must follow the annual booking process and respect slot/space constraints.
- Annual booking justifications should reuse prior rationale blocks but require fresh confirmation each year.

### Ad hoc bookings
- Ad hoc bookings should require minimum-notice checks.
- If the activity is outside the core RA, the system should block booking-draft completion until proposal / RA prerequisites are addressed.

## 7. Funding rules
### ADF
- Use only when activity is new, developing, or an unbudgeted success.
- Do not draft as eligible if the request is obviously excluded by scheme rules.

### Trips Fund
- Do not mark sporting fixtures/BUCS competitions as eligible if policy excludes them.
- Require trip proposal / budget prerequisites before marking ready to submit.

## 8. Safety rules
- Risk assessment output is always a first draft.
- Safety-critical controls, emergency procedures, named responsible persons, and first aider details require manual verification.
- If location, travel mode, or attendee type changes, the existing RA should be treated as stale.

## 9. Messaging rules
- Payment chaser messages must remain factual, polite, and non-accusatory.
- Do not mention private financial details that the recipient does not need.
- Batch messaging should support group segmentation by issue type.
- Correspondence to staff should avoid invented policy claims.

## 10. Workflow engine rules
- Every state transition must create an audit event.
- Every rejected draft should preserve reviewer feedback.
- A workflow can be resumed from a saved state without re-running every generation step.
- A manual override should be possible, but it must be logged.

## 11. Integration rules
- External systems must be accessed through adapters, not directly from workflow logic.
- eActivities adapter and Pluto adapter must implement a shared internal interface.
- If an adapter fails, the workflow should degrade gracefully and show what data is missing.

## 12. Security rules
- Never embed credentials from committee notes into repo docs or prompts.
- Use secure secret storage in runtime environments.
- Separate admin-only views from general committee views.
- Store outbound message approvals and sends in an append-only log.

## 13. Multi-society scaling rules
- Society-specific templates must inherit from shared template families.
- Society-specific constants should live in configuration, not code.
- No workflow should assume judo-specific language or timing once generalized.
