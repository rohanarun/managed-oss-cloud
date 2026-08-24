# Applicant tracking module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `hire` |
| Working category | Recruiting and applicant tracking |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for many recruiters, large resume storage, high application volume, or long retention |
| License target | Original first-party source under MIT |
| Primary outcome | A hiring team can publish roles, receive applications, coordinate structured human review, and preserve an explainable recruiting history. |

The module is human-controlled decision support. It must not autonomously reject, rank conclusively, or hire candidates. Customers remain responsible for employment law, notices, accommodation, retention, and bias review in every operating jurisdiction.

## Public behavioral research record

- [OpenCATS public repository and README](https://github.com/opencats/OpenCATS) describes job postings, candidate/application management, recruiting pipelines, client/company records, and recruiter workflows.
- [OpenCATS mixed license record](https://github.com/opencats/OpenCATS/blob/master/LICENSE.md) documents Mozilla Public License and legacy CATS Public License portions.
- [Horilla HR public repository and README](https://github.com/horilla/horilla-hr) describes recruitment, onboarding/offboarding, employee management, attendance, leave, and related HR workflows.
- [Horilla LGPL-2.1 license](https://github.com/horilla/horilla-hr/blob/2.0/LICENSE) is the official upstream license record.

No OpenCATS or Horilla source, schema, stage defaults, scoring logic, workflows, forms, copy, visual design, tests, seed data, or assets may be used. The scope here is an original recruiting module, not a fork or compatibility layer.

## Clean-room boundary

### Permitted inputs

- The business behaviors summarized in this specification.
- Customer-authored roles, application forms, interview plans, scorecards, retention policies, and communications.
- Official APIs for job boards, calendars, email, identity, storage, and e-sign providers selected by the customer.
- Published accessibility and employment guidance after source/version review.

### Prohibited inputs

- Reference source code, database design, stage names/order, scoring formulas, endpoint names, forms, dashboards, or templates.
- Automatic decisions based on protected attributes or inferred proxies.
- Scraping private candidate data, purchasing hidden enrichment, facial/emotion analysis, or inferring health, ethnicity, religion, age, disability, sexuality, pregnancy, or other sensitive traits.
- Representing model output as objective suitability or a legal employment decision.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage retention, integrations, roles, members, exports, and deletion policy. |
| Recruiting admin | Configure pipelines, forms, sources, templates, and reporting. |
| Recruiter | Create jobs, review assigned candidates, coordinate interviews, and prepare offers. |
| Hiring manager | Review candidates for assigned jobs and approve stage/offer decisions. |
| Interviewer | Access only assigned interview packet and submit an independent scorecard. |
| Candidate | View/apply to public jobs, manage own application, submit consent, request export/correction/deletion. |
| Auditor | Read decision, access, retention, consent, and deletion evidence without editing records. |

Candidate export/deletion, offer approval, disposition, bulk communications, retention changes, and integration management require privileged scopes. Interviewers cannot see other scorecards until they submit their own when blind-review mode is enabled.

## Original data requirements

The implementation owns a PostgreSQL schema named `hire`.

### `job`

- Workspace, original title, department/location/work mode, description, employment type, compensation display authored by customer, openings, owner, hiring team, pipeline version, application-form version, publication channels, and state.
- States: `draft`, `approved`, `published`, `paused`, `closed`, `archived`.
- Published versions are preserved for each application.

### `pipeline` and `stage`

- Versioned workspace-defined stages, ordering rules, allowed transitions, required approvals, SLAs, and terminal disposition requirements.
- No hidden model-score threshold exists in a stage transition.

### `candidate`

- Workspace-scoped person record with supplied name/contact fields, preferred locale/time zone, source, consent/notice state, duplicate links, and lifecycle state.
- Sensitive demographic data is excluded from the core candidate profile unless a separate legally reviewed voluntary reporting feature is implemented with access segregation.

### `application`

- Candidate, exact job/form/pipeline versions, source, submitted answers, current stage, state, timestamps, assigned team, and retention deadline.
- A candidate may have multiple applications; merging candidates does not merge distinct application histories.
- States: `draft`, `submitted`, `active`, `withdrawn`, `hired`, `not_selected`, `closed`, `deletion_pending`, `deleted`.

### `resume_document`

- Private object reference, content hash, media type, scan state, extraction version, structured proposal, confidence per field, corrections, and retention class.
- The original document remains immutable and is never publicly addressable.

### `application_event`

- Append-only stage transition, assignment, note, consent, communication, decision, withdrawal, correction, or deletion event with actor, reason, source version, and timestamp.

### `interview_plan`

- Job/stage, competencies, original questions, accessibility notes, interviewer assignments, schedule rules, and scorecard version.
- Candidate accommodation details use a restricted field class and minimum audience.

### `interview`

- Application, plan version, schedule, participants, calendar references, state, and meeting evidence.
- States distinguish requested, scheduled, completed, canceled, and no-show without inferring intent.

### `scorecard`

- Interview, interviewer, competency criteria, ratings, evidence notes, recommendation, submitted time, and version.
- Submitted scorecards are immutable; corrections append an amendment.
- A scorecard does not calculate a final hiring decision.

### `decision`

- Application, decision type, reason taxonomy selected by authorized humans, evidence references, approvers, time, and communication state.
- Hired and not-selected decisions require a human actor and the configured approval chain.

### `offer`

- Application, terms supplied by the customer, approvals, version, delivery, candidate response, and optional external signature link.
- Offer documents are private and immutable once sent; revisions create new versions.

### `communication`

- Application/candidate, channel, approved template version, recipients, content hash or retention-safe body, delivery attempts, and consent/suppression context.

### `consent_notice`

- Notice/version, purpose, retention, candidate decision, source, effective time, withdrawal, and evidence.

### `deletion_request`

- Candidate request, identity-verification state, affected records/files/connectors, retention exception with reason, execution state, and completion evidence.

## Required workflows

### 1. Create and publish a job

1. A recruiter drafts a job, application form, hiring team, pipeline, and interview plan.
2. AI may propose language, competencies, or questions and highlight exclusionary wording as suggestions.
3. Deterministic preflight checks required fields, active form/pipeline versions, privacy notice, accessible form controls, and publication authorization.
4. An authorized approver publishes the exact version.
5. Public listing and application endpoints expose only approved fields and a stable job version.

### 2. Apply

1. A candidate reads the exact job and data notice, optionally saves a draft, and submits required answers/files.
2. Uploads are type/size checked, virus-scanned, private, and content-addressed.
3. Submission atomically creates candidate/application records, notice evidence, and an application event.
4. Duplicate suggestions are non-destructive and never block the applicant.
5. The candidate receives a scoped status link or authenticated portal.

### 3. Parse and review a resume

1. Deterministic text extraction runs before optional model analysis.
2. AI proposes structured facts with source spans and confidence.
3. Unsupported or uncertain fields remain empty/uncertain.
4. A recruiter can correct proposals without altering the source file.
5. Protected or sensitive inferred traits are neither requested nor stored.

### 4. Move through a pipeline

1. An authorized human reviews the application and evidence.
2. A requested transition is validated against the bound pipeline version, role, approvals, and required reason/evidence.
3. The transition appends an event and updates the current stage transactionally.
4. AI may suggest next actions but cannot perform terminal transitions.
5. Bulk actions display exact affected applications and require confirmation.

### 5. Interview and score

1. Recruiting schedules an interview using customer-authorized calendars.
2. Interviewers receive only the minimum packet for their assignment.
3. Each submits a structured scorecard with evidence.
4. Blind-review mode prevents anchoring on others' ratings.
5. A hiring manager reviews scorecards and makes a separate human decision.

### 6. Offer or disposition

1. An offer draft receives configured approvals before sending.
2. Candidate acceptance/decline records signed provider evidence or explicit portal action.
3. A not-selected decision records an authorized human reason and communication policy.
4. No model score or missing enrichment can be the sole terminal-decision reason.

### 7. Candidate rights and retention

1. A candidate can request a portable copy, correction, withdrawal, or deletion.
2. The module verifies the requester without collecting excessive new identity data.
3. It identifies affected files, records, exports, search indexes, and configured connectors.
4. Legally/customer-required retention exceptions are explicit, time-bounded, and auditable.
5. Completion removes eligible data, tombstones identifiers needed to prevent resurrection, and records non-identifying counts/evidence.

### 8. Reporting

1. Reports derive from immutable events and expose cohort/time definitions.
2. AI may summarize funnel bottlenecks but must cite counts and cannot attribute demographic cause without valid segregated data and legal review.
3. Small cohorts are suppressed according to workspace policy.

## AI contract

### Allowed AI actions

- Draft job descriptions, interview plans, candidate communications, and scorecard criteria for review.
- Extract resume facts with source spans and confidence.
- Summarize a candidate's submitted materials and interview evidence with citations.
- Suggest duplicate records, next steps, scheduling options, and pipeline risks.
- Identify potentially vague or exclusionary language as a review prompt.

### Forbidden AI actions

- Autonomously rank, reject, hire, advance terminally, set compensation, or send an offer.
- Infer protected/sensitive traits or use proxies for them.
- Fabricate experience, credentials, interview evidence, reference results, or delivery status.
- Score facial expressions, voice emotion, personality, honesty, disability, or cultural fit.
- Train a shared model on candidate data without separate explicit authorization and governance.
- Send complete resumes or accommodation data to a remote model unless the workspace explicitly configures that provider, scope, and disclosure.

Every AI summary shows source record/span references and omissions. Humans must see original evidence before a terminal decision.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite hire job create --file job.json
supersuite hire job publish --job JOB_ID --confirm-version VERSION
supersuite hire application list --job JOB_ID --stage screening
supersuite hire resume parse --application APPLICATION_ID
supersuite hire application transition --application APPLICATION_ID --to interview --reason REASON
supersuite hire interview schedule --application APPLICATION_ID --plan PLAN_ID
supersuite hire candidate export --candidate CANDIDATE_ID
supersuite hire deletion execute --request REQUEST_ID --confirm-plan PLAN_HASH
```

Required MCP tools:

- `hire_job_list`
- `hire_job_draft`
- `hire_job_publish`
- `hire_application_list`
- `hire_application_get`
- `hire_resume_extract`
- `hire_candidate_summarize`
- `hire_transition_preview`
- `hire_transition_apply`
- `hire_interview_schedule`
- `hire_scorecard_submit`
- `hire_decision_record`
- `hire_candidate_export`
- `hire_deletion_preview`

Terminal transitions, decisions, offers, bulk actions, and deletion execution require human-only mutation scopes and exact version/plan confirmation. An agent scope cannot be elevated merely because the MCP caller is an AI client.

## Resource and plan contract

- Starter supports normal small-business roles, applications, interviews, and documents within pooled quotas.
- Scale is recommended for many recruiters, high application/file volume, long retention, OCR, or calendar/email integrations.
- Job-board posting, background checks, e-sign, email/SMS, calendar, OCR/model, and object-storage costs are separate.
- Public application traffic has per-site abuse controls that do not silently discard legitimate submissions.

## Security, privacy, and fairness requirements

- Candidate and offer files are private, encrypted, content-addressed, and delivered with short-lived authorization.
- Role/job assignment and field-level controls protect notes, offers, accommodation, and deletion data.
- Public forms use rate limits, malware protection, accessible error handling, and safe file parsing.
- All access to candidate detail, file download, export, terminal decision, bulk action, and deletion is audited.
- Search indexes carry workspace and authorization filters and honor deletion tombstones.
- AI context is allowlisted and redacted; protected/sensitive fields are not included.
- Reporting suppresses small cohorts and exposes definitions, missing data, and clocks.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| HIR-001 | Two workspaces with candidates sharing the same email cannot access, search, merge, summarize, export, or mutate each other's data through public, web, HTTP, CLI, MCP, worker, or file URLs. |
| HIR-002 | A candidate submits against job/form/pipeline version N; later job edits do not rewrite the version or answers bound to that application. |
| HIR-003 | A resume upload containing malware is quarantined, creates no parse/model job, and is not downloadable through the candidate or recruiter path. |
| HIR-004 | Resume extraction returns source spans and per-field confidence; an unsupported credential remains absent rather than inferred. |
| HIR-005 | A duplicate suggestion does not block submission or merge records; an authorized merge preserves every distinct application/event and can be audited. |
| HIR-006 | An interviewer in blind-review mode cannot read another scorecard until submitting their own; submission is immutable and corrections append amendments. |
| HIR-007 | A model or agent attempting `hired` or `not_selected` is denied even when it possesses general module mutation scope. |
| HIR-008 | A human terminal decision lacking the configured reason/approval is rejected atomically and leaves the current stage unchanged. |
| HIR-009 | AI summary claims are traceable to application, resume span, answer, or scorecard evidence; unsupported claims fail validation. |
| HIR-010 | Candidate withdrawal stops new recruiting actions according to policy and remains distinct from employer disposition. |
| HIR-011 | A deletion preview lists affected records/files/indexes/connectors and exceptions; execution of the confirmed hash removes eligible data and cannot resurrect it on reindex. |
| HIR-012 | Public candidate status tokens reveal one application only, expire/revoke correctly, and cannot enumerate jobs or candidates. |
| HIR-013 | Bulk communication preview and execution use the same immutable recipient set; a changed set requires new confirmation. |
| HIR-014 | Backup restore preserves job/application versions, events, scorecards, decisions, file hashes, consent evidence, and retention deadlines. |
| HIR-015 | CLI and MCP transition previews return the same allowed transitions, requirements, version, and permission failures. |
| HIR-016 | With AI disabled, jobs, applications, resume storage, stages, interviews, scorecards, offers, communications, reports, exports, and deletion workflows remain functional. |
| HIR-017 | Keyboard-only and screen-reader testing completes the public application, correction, withdrawal, and status workflows with understandable errors. |

## Explicitly deferred

- Payroll, attendance, performance management, benefits, or employee surveillance.
- Background-check execution, immigration advice, or automated reference investigation.
- Autonomous candidate ranking or terminal decisions.
- Facial, voice, emotion, personality, honesty, or protected-trait inference.
- A global resume enrichment database or cross-customer candidate graph.
