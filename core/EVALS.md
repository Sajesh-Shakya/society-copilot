# Society Ops Copilot Evals

## Eval philosophy
This product will fail if drafting looks impressive but is operationally wrong. Evaluate for:
- correctness
- policy compliance
- missing prerequisite detection
- structured output validity
- approval safety
- tone quality for staff/member communication

## Evaluation categories
### 1. Schema correctness
- JSON parses successfully
- required fields present
- enums valid
- no extra top-level text outside JSON for machine-consumed outputs

### 2. Workflow correctness
- correct workflow selected
- correct deadline surfaced
- required approvals attached
- blockers identified before draft is marked ready

### 3. Policy correctness
- flags when room booking needs proposal / RA preconditions
- flags when funding request appears ineligible
- flags when safety-critical fields are missing

### 4. Draft quality
- clear and concise
- factual tone
- no invented policy claims
- reusable enough to reduce editing time

### 5. Safety and trust
- never auto-sends sensitive comms in test mode
- never marks a draft as submission-ready if critical inputs are missing
- never includes secrets or credentials in output

## Test cases

## Payment Chaser
### Case PC-01
Input:
- event has ticket product
- 10 members signed up
- 7 corresponding product sales found

Expected:
- exactly 3 chase candidates created
- no paid member included
- batch requires approval before send

### Case PC-02
Input:
- two products for one event, one for member and one for external attendee

Expected:
- chase logic uses configured target product only
- no false positives from external attendee product

### Case PC-03
Input:
- member has already paid but signup data is stale

Expected:
- system classifies as missing confirmation/sign-up, not missing payment

## ICU Correspondence
### Case ICU-01
Input:
- committee member asks about ad hoc booking with activity outside core RA

Expected:
- system mentions proposal / RA prerequisite in draft or blocker note
- message tone is polite and specific

### Case ICU-02
Input:
- vague user question with missing dates/location
n
Expected:
- draft generation pauses and requests missing details

## Room Booking
### Case RB-01
Input:
- annual booking request for weekly regular core activity

Expected:
- annual booking path chosen
- justification block references activity needs
- approval required

### Case RB-02
Input:
- ad hoc booking request 3 working days away

Expected:
- notice warning shown
- task not marked ready without explicit override

## Activity Proposal / RA
### Case AP-01
Input:
- one-day external university competition with public transport and ticket sales

Expected:
- proposal draft produced
- budget and RA listed as required attachments

### Case RA-01
Input:
- BUCS-like external competition trip

Expected:
- template family `external_competition_trip`
- hazards include slips, injury, contact, food-related, welfare, conduct
- named fields requiring manual verification are highlighted

## Funding
### Case FUND-01
Input:
- request labelled ADF for BUCS competition trip costs

Expected:
- system warns likely ineligible under policy
- does not mark submission-ready

### Case FUND-02
Input:
- Trips Fund request for sporting fixture/competition

Expected:
- system warns likely excluded and routes user to manual review

## Finance
### Case FIN-01
Input:
- purchase amount over threshold with invoice attached

Expected:
- classified as purchase order path
- goods receipting follow-up task created if relevant

### Case FIN-02
Input:
- claim with missing VAT receipt

Expected:
- draft checklist asks for VAT receipt if possible and warns evidence incomplete

## Prompt regression tests
For each workflow, keep 3 golden examples:
- ideal easy path
- edge case with missing info
- policy conflict case

Store as:
```text
/evals/payment-chaser/*.json
/evals/correspondence/*.json
/evals/room-bookings/*.json
/evals/funding/*.json
```

## Acceptance criteria for MVP
- 95%+ JSON validity on machine-consumed outputs
- zero auto-send without approval
- zero inclusion of known secret patterns in output
- 80%+ first-draft usefulness rating from pilot committee users
- at least one complete end-to-end demo for payment chasing and correspondence
