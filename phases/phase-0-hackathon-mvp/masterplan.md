# **masterplan.md**

## 30-second elevator pitch

An AI copilot for society committees that turns messy admin into one-click workflows.
Describe what you want to do → get a complete, approval-ready output (risk assessments, proposals, messages, budgets).

---

## Problem & mission

### Problem

Committee members:

* Don’t know **what to do next**
* Repeat the same admin work every year
* Risk **missing deadlines or breaking policy**

Work is:

* fragmented (eActivities, forms, email, WhatsApp)
* repetitive (risk assessments, budgets)
* high-stakes (finance, safety, approvals)

### Mission

Reduce admin time by **50%+** by removing thinking, not just typing.

---

## Target audience

### Primary

* Treasurer → finance + compliance
* President → planning + approvals
* Secretary → comms + coordination

### Secondary

* Trip organisers
* Welfare / equipment officers

---

## Core product idea (BIG insight)

> Users don’t want tools.
> They want **“tell → done”**

---

## Core features

### 1. Task → Workflow engine

User inputs:

> “Plan Warwick trip”

System:

* detects workflow
* generates full output pack:

  * proposal
  * risk assessment
  * budget
  * checklist

---

### 2. Smart drafting (AI)

* Risk assessments from templates
* Payment chase messages
* Room booking justifications
* Funding applications

---

### 3. Approval system (critical)

* Nothing is auto-sent
* Everything requires approval
* Full audit trail

---

### 4. Policy + rules engine

* detects missing prerequisites
* flags deadlines
* prevents invalid actions

Example:

> “You need RA before booking”

---

### 5. Data integration (modular)

* eActivities (read-first)
* Pluto (future)

---

## High-level tech stack

* Frontend: Next.js → fast UI + simple flows
* Backend: FastAPI / Node → workflow engine
* DB: PostgreSQL → structured workflows
* Queue: BullMQ → reminders + async tasks
* AI: OpenRouter / OpenAI → structured drafting

Why:

* Supports structured workflows + async tasks + modular adapters

---

## Conceptual data model

Entities:

* WorkflowTask (core unit)
* Draft (RA, message, proposal)
* ApprovalDecision
* ExternalData (eActivities snapshot)

Flow:
User input → Workflow → Draft → Approval → Completion

---

## UI design principles (Krug)

* “Don’t make me think”

  * Always suggest next action

* “3 mindless clicks”

  * Input → Review → Approve

* “Self-evident”

  * Show outputs, not forms

---

## Security & compliance

* No auto-send
* Approval required for:

  * messaging
  * submissions
  * spending
* No secrets in prompts
* Full audit logs

---

## Phased roadmap

### MVP (hackathon)

* Payment chaser
* Correspondence drafting
* RA / proposal generator

### V1

* Full trip workflow
* Room booking assistant
* Finance assistant

### V2

* Multi-society support
* Analytics
* Workflow marketplace

---

## Risks & mitigations

| Risk                | Mitigation            |
| ------------------- | --------------------- |
| Wrong policy output | require approval      |
| Over-complex UX     | enforce 3-step flows  |
| API limits          | low-volume adapter    |
| user distrust       | show sources + checks |

---

## Future ideas

* Auto deadline tracker
* “Reuse last year” intelligence
* Committee onboarding assistant
* Cross-society templates

---

