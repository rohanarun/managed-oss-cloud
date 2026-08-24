# Forms and data collection module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `forms` |
| Working category | Forms, surveys, and structured data collection |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for high submission or upload volume, many public domains and locales, frequent exports, or long retention |
| License target | Original first-party source under MIT |
| Primary outcome | A team can publish an accessible, versioned data-collection experience and trust that every retained submission was validated against the exact contract the respondent saw. |

This module collects general business information. It is not a payment form, password manager, electronic-signature ceremony, clinical-record system, identity-verification service, or compliance certification. The deterministic form, validation, submission, export, and deletion paths must work with AI disabled.

## Scope

In scope are typed form contracts, immutable public releases, accessible hosted and embedded rendering, bounded conditional logic, partial sessions, server-validated submissions, safe optional uploads, corrections, typed delivery events, aggregate analysis, exports, respondent rights, retention, and deletion. CRM, Feedback, Consent, Automate, Notify, storage, scanning, and outbound providers connect through explicit versioned adapters.

Payments, signatures, credentials, protected-health workflows, identity proofing, arbitrary executable customization, and automated eligibility decisions are outside the module. The final section records additional deferred work.

## Public behavioral research record

Research sources establish public behavior only. They are not implementation dependencies.

- [Formbricks experience-management and surveys documentation](https://formbricks.com/docs/xm-and-surveys) publicly describes question building, variables, conditional logic, quotas, analytics, exports, webhooks, and API-based automation.
- [Formbricks REST API documentation](https://formbricks.com/docs/api-reference/rest-api) distinguishes an unauthenticated public client surface for interactions from an authenticated management surface.
- [Formbricks response API documentation](https://formbricks.com/docs/api-v2-reference/management-api--responses/get-responses) demonstrates structured response values, variables, completion state, timing, metadata, contact attributes, and pagination.
- [Formbricks file-upload configuration](https://formbricks.com/docs/self-hosting/configuration/file-uploads) describes optional object storage for form and workspace assets.
- [Formbricks license statement](https://github.com/formbricks/formbricks/blob/main/README.md#license) records an AGPLv3 core and separately licensed enterprise code.
- [JSON Schema 2020-12 specification](https://json-schema.org/specification) defines a public core and validation vocabulary for structured JSON instances.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) is the primary accessibility standard used for the public respondent surface.

No Formbricks source, schema, migrations, internal endpoints, question identifiers, examples, tests, templates, interface copy, visual design, translations, assets, analytics implementation, or enterprise behavior may be used. This module is an original data-contract system, not a fork or compatibility layer.

## Clean-room boundary

### Permitted inputs

- This specification, JSON Schema's public vocabulary, browser platform documentation, and accessibility standards.
- Official provider documentation for customer-selected object storage, email, anti-abuse, and webhook services.
- Customer-authored form questions, help text, consent language, themes, translations, retention policy, and destinations.
- General-purpose permissively licensed validators, parsers, renderers, and file-inspection libraries after dependency review.
- Independently authored validation and accessibility vectors.

### Prohibited inputs

- Reference-product source, bundles, schemas, migrations, tests, fixtures, seed surveys, endpoint or internal model names, logic representation, or analytics formulas.
- Reference-product editor layout, respondent layout, wording, icons, styles, templates, default question catalog, or translations.
- Arbitrary JavaScript, SQL, template code, regular expressions without safety bounds, or model-generated executable expressions in a form definition.
- Core field types intended for passwords, authentication secrets, payment cards, bank credentials, protected health records, biometric templates, or government identity documents.
- Fabricated, rewritten, or silently completed respondent answers.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage domains, members, retention, provider connections, raw exports, deletion, and sensitive-field policy. |
| Form editor | Create forms, fields, pages, rules, translations, themes, and draft releases. |
| Publisher | Review a semantic diff and publish, pause, replace, or withdraw an exact release. |
| Analyst | Read aggregate results and approved row-level fields according to field classifications. |
| Data steward | Review quarantine, correction, export, withdrawal, retention, and deletion requests. |
| Respondent | Read one published form release, save or submit allowed answers, upload approved files, and exercise scoped rights through a token. |
| Runtime integration | Validate or submit to one approved release using a narrowly scoped credential. |
| Auditor | Read publication, submission, access, export, webhook, retention, and deletion evidence without editing source answers. |

Public respondents cannot enumerate forms, releases, workspaces, submissions, contacts, exports, or webhook destinations. Publication, raw response export, retention changes, provider credentials, bulk deletion, and access to restricted fields require privileged scopes.

## Original data requirements

The implementation owns a PostgreSQL schema named `forms`. JSON is the submitted value format, but definitions, releases, field classifications, submission lineage, files, and delivery evidence use typed tables and constraints.

### `form`

- Workspace-scoped name, stable key, purpose, owner, default locale, lifecycle state, retention class, allowed domains, and current draft identifier.
- States: `draft`, `approved`, `published`, `paused`, `retired`.
- Retiring a form stops new sessions but preserves release and submission evidence according to policy.

### `schema_revision`

- Monotonic version, form, title and description, field definitions, page structure, validation vocabulary, answer-size limits, locale bundle references, author, state, and content hash.
- States: `draft`, `approved`, `published`, `superseded`, `withdrawn`.
- Published revisions are immutable and self-contained enough to validate an old submission after later edits.
- The module supports a documented bounded subset or profile of JSON Schema 2020-12; unsupported keywords fail publication instead of being ignored ambiguously.

### `field_definition`

- Stable field key, original label/help text, value type, cardinality, required rule, validation constraints, choices, purpose, privacy class, retention class, analytics class, model-exposure class, and display position.
- Core value types include short/long text, boolean, integer/decimal, date, time, date-time, choice, multi-choice, email, URL, phone text, address components, rating, matrix, and approved file reference.
- A field's stable key is never recycled for a semantically different fact.
- A field cannot be required while permanently unreachable; sensitive types forbidden by this specification cannot be published through a generic extension.

### `logic_rule`

- Revision, priority, typed predicates over existing field keys or safe request context, and allowlisted effects such as show, hide, require, skip to page, terminate with an approved outcome, or set a deterministic derived value.
- Rules form an acyclic dependency/control graph. Every reference and destination must exist in the same revision.
- Evaluation has defined null, missing, type-mismatch, and multi-choice semantics.
- Logic never executes code, performs a network request, or asks a model during a respondent session.

### `form_release`

- Immutable public contract containing exact schema revision, locale bundle, presentation tokens, domain bindings, open/close window, response quota, duplicate policy, identity mode, save/resume policy, completion outcomes, and content hash.
- The release has an opaque public identifier and optional unique slug within a verified domain.
- A release can be paused or withdrawn prospectively; existing submissions retain it.
- Presentation tokens are constrained design values, not arbitrary CSS or HTML.

### `respondent_session`

- Release, opaque session key digest, start/update/expiration times, locale, state, current page, save/resume policy, anti-abuse result, and optional authorized contact link.
- States: `started`, `partial`, `ready`, `completed`, `expired`, `withdrawn`, `quarantined`.
- Anonymous mode does not manufacture a contact identity or fingerprint.
- Resume tokens are purpose-bound, revocable, high entropy, and stored only as digests.

### `submission` and `response_value`

- Submission has workspace, form/release/schema identifiers and hashes, respondent session, state, idempotency key, submitted time, validation result hash, source class, consent evidence, and retention deadline.
- Response values are typed by stable field key with canonical JSON value, source version, privacy class, and optional correction lineage.
- Finalization appends an immutable `submission_event`; source answers are not silently rewritten.
- States distinguish `partial`, `submitted`, `quarantined`, `accepted`, `withdrawn`, `deletion_pending`, and `deleted` without claiming downstream processing success.

### `submission_event`

- Append-only save, validate, finalize, quarantine, accept, tag, correction, withdrawal, export, delivery, retention, or deletion event with actor/source, clock, exact release/version, and evidence.
- A correction preserves the original value and reason. It does not impersonate the respondent's original answer.
- Automation side effects reference events rather than polling mutable rows.

### `upload`

- Private object reference, workspace/session/field binding, original filename separately escaped, detected media type, byte size, content hash, scan state, quarantine reason, retention class, and deletion state.
- States: `initiated`, `uploaded`, `scanning`, `clean`, `quarantined`, `rejected`, `deleted`.
- Files never become publicly addressable. A submission cannot finalize while a required upload is unverified.

### `delivery_rule` and `delivery_attempt`

- Versioned, allowlisted event trigger and destination reference for the suite event bus, customer-owned webhook, Notify workflow, CRM mapping, or approved export sink.
- Mappings operate over declared field keys and preserve privacy classes.
- Attempts record immutable event, destination version, idempotency key, redacted result, retry state, and provider receipt.
- A successful local submission is not rolled back because downstream delivery failed.

### `export_job`

- Bounded form/release/date/filter selection, explicit field projection, requester, purpose, format, row estimate, state, content hash, object reference, expiration, and download audit.
- Tabular output protects against spreadsheet formula execution and preserves type/locale metadata.
- Raw restricted fields require an elevated purpose and are excluded by default.

### `rights_request`

- Respondent request for access, correction, withdrawal, or deletion; verification state; exact affected sessions/submissions/files/deliveries; exceptions; plan hash; and execution evidence.
- Completion tombstones tokens and indexes needed to prevent accidental resurrection.

## Required workflows

### 1. Draft a form contract

1. An editor defines purpose, fields, privacy/retention/model classes, pages, validation, logic, locales, and outcomes.
2. Deterministic preflight validates the supported schema vocabulary, stable keys, types, bounds, choice values, reachability, logic graph, locale completeness, file policy, and accessibility metadata.
3. AI may propose questions or a logic diff, but the proposal remains separate from the draft until accepted.
4. A publisher reviews a semantic change report including newly collected facts, changed requirements, privacy classes, and downstream mappings.
5. Approval records the exact revision hash.

### 2. Publish a release

1. The publisher selects a verified domain, schedule, quota, identity mode, duplicate policy, save/resume behavior, theme tokens, and completion outcomes.
2. Preflight rejects unverified domains, unsafe redirects, arbitrary executable content, incomplete notices, unavailable required uploads, and unsupported field types.
3. Publication atomically exposes an immutable release and preserves any prior release.
4. A pause stops new sessions; a withdrawal can also stop completion according to a clearly displayed policy.
5. Editing any contract field creates a new release and public version.

### 3. Render and navigate

1. The respondent retrieves one release in a supported locale.
2. The server or trusted renderer evaluates deterministic logic over canonical typed answers.
3. The UI exposes current progress, required state, errors, privacy notice, save behavior, and completion effect without dark patterns.
4. Hidden fields are not submitted from stale client state unless the release explicitly preserves them and discloses that behavior.
5. Keyboard, screen-reader, zoom, reduced-motion, and error-recovery behavior meets the documented accessibility baseline.

### 4. Validate and finalize a submission

1. The respondent submits answers, upload references, exact release identifier, and an idempotency key.
2. The server ignores client claims about visibility/required state and independently evaluates the pinned schema and logic.
3. Type, size, choice, cross-field, quota, session, consent, anti-abuse, and clean-upload checks run before final state.
4. A single transaction records canonical values, validation hash, submission event, and outbox events.
5. Retrying returns the same logical submission; invalid input stores no submitted facts or downstream work.

### 5. Save, resume, and correct

1. A release may allow anonymous or identified partial saves with an explicit expiration.
2. A raw resume token is issued once and later verified against its digest, purpose, release, and expiry.
3. Resume reads only that session and re-renders under the pinned release.
4. Post-submission correction requires a scoped link or authorized steward, records reason and actor, and appends value versions.
5. Corrections trigger new versioned delivery events rather than altering old receipts.

### 6. Deliver and automate

1. Finalization emits a typed immutable suite event referencing the submission and release.
2. Each configured mapping receives only its declared fields and classifications.
3. Webhooks are HTTPS, signed, SSRF-safe, idempotent, and retried with bounded backoff.
4. CRM, Feedback, Consent, Automate, and Notify integrations consume explicit mapping versions through their own authorization paths.
5. Delivery receipts distinguish queued, accepted, delivered where provable, rejected, unknown, and suppressed.

### 7. Analyze and summarize

1. Deterministic reports state release/filter/time range, denominator, missing/withdrawn/quarantined handling, and query clock.
2. Row-level access obeys field classification and role.
3. AI may summarize exact aggregates or selected responses with citations to query/result and allowed submission identifiers.
4. A model cannot fill missing answers, treat skipped fields as negative answers, or claim causality from a survey.
5. Small cohorts and free-text examples follow workspace disclosure policy.

### 8. Export, rights, retention, and deletion

1. An authorized user previews field projection, row count, privacy classes, format, and downstream references.
2. Export execution binds to the preview hash and creates a short-lived encrypted artifact.
3. A respondent rights request verifies possession without collecting excessive new identity data.
4. Deletion removes eligible values, files, search indexes, cached analytics, and configured downstream copies where supported, preserving explicit exceptions and non-identifying audit evidence.
5. Backup restore honors deletion tombstones, token revocations, release immutability, and delivery idempotency.

## Public surfaces

- A custom-domain hosted form renders one immutable release and supports locale selection when published.
- An embeddable renderer may consume a signed release manifest but cannot receive management credentials or arbitrary executable form content.
- Public session endpoints support start, validate, bounded partial save, resume, file initiation/finalization, submit, and scoped rights actions.
- Optional prefill uses purpose-bound signed data with field allowlists, short expiration, and an explicit preview; query-string PII is not a default mechanism.
- Public responses never reveal internal field classifications, logic internals beyond what is needed to render, submission counts that enable quota races, or whether an arbitrary contact already responded.
- Origin/domain binding, uniform non-enumerating errors, request and field-size limits, anti-automation controls, safe redirects, CSRF/origin policy where applicable, and accessible structured validation errors are mandatory.

## AI contract

### Allowed AI actions

- Draft an original form outline, field labels, help text, translation, or branching proposal for review.
- Suggest data-minimization improvements, ambiguous wording, missing answer choices, or accessibility issues.
- Classify free text into a customer-defined taxonomy with cited submission identifiers and confidence.
- Summarize exact aggregate results or an explicitly selected response set with citations, denominator, filters, and query clock.
- Draft a downstream mapping or follow-up message without executing or publishing it.

### Forbidden AI actions

- Publish, pause, withdraw, delete, export restricted rows, send, or change permissions.
- Create, complete, correct, rewrite, or infer a respondent answer.
- Invent counts, completion rates, sentiment, demographics, delivery status, consent, or causal conclusions.
- Generate executable JavaScript, SQL, templates, or unbounded expressions for the runtime logic engine.
- Receive provider secrets, raw resume tokens, quarantined files, disallowed field classes, or unrestricted full-response tables.
- Reidentify anonymous respondents, infer protected traits, or combine workspaces into a shared respondent graph.

Every AI result records the exact allowlisted release, query, field and submission identifiers, redactions, model metadata, prompt version, output, confidence where relevant, and reviewer outcome. AI has no authority in validation, logic evaluation, submission finalization, retention, or access control.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite forms form create --name "Customer intake" --purpose customer_onboarding
supersuite forms schema set --form FORM_ID --file schema.json --confirm-version VERSION
supersuite forms logic validate --revision REVISION_ID
supersuite forms release publish --revision REVISION_ID --domain forms.example.com --confirm-hash SHA256
supersuite forms submission validate --release RELEASE_ID --file response.json
supersuite forms submission create --release RELEASE_ID --file response.json --idempotency-key KEY
supersuite forms submission correct --submission SUBMISSION_ID --file correction.json --confirm-version VERSION
supersuite forms export preview --form FORM_ID --from 2026-09-01 --to 2026-09-30 --fields fields.json
supersuite forms export create --preview PREVIEW_ID --confirm-hash SHA256
supersuite forms rights delete --request REQUEST_ID --confirm-plan SHA256
```

Required MCP tools:

- `forms_form_list`
- `forms_form_draft`
- `forms_schema_validate`
- `forms_logic_validate`
- `forms_release_diff`
- `forms_release_publish`
- `forms_submission_validate`
- `forms_submission_create`
- `forms_submission_get`
- `forms_submission_correct`
- `forms_results_query`
- `forms_results_summarize`
- `forms_export_preview`
- `forms_export_create`
- `forms_rights_preview`

Publication, raw row reads, restricted-field access, correction, bulk mutation, export execution, rights execution, retention, and provider changes require explicit scopes and exact version/hash confirmation. Agent scope cannot elevate itself into restricted respondent-data or deletion authority.

## Resource and plan contract

- Starter supports normal small-business forms, releases, public domains, submissions, small assets, reports, and bounded exports within pooled quotas.
- Scale is recommended for high submission or upload volume, many domains/locales, large response matrices, frequent webhook work, many analysts, long retention, or recurring large exports.
- Fleet is capacity guidance for sustained high concurrency, storage, or isolation needs; it does not enable weaker validation or broader AI authority.
- Object storage, malware scanning, anti-abuse, outbound email/SMS, webhooks, and customer data sinks are separately metered or customer-funded.
- Quotas are enforced at release/session/upload/submit/export boundaries with explicit errors; accepted submissions are never silently discarded because a downstream quota changed.

## Security, privacy, and accessibility requirements

- Row-level security scopes form, release, session, submission, upload, result, export, and delivery data to the workspace.
- Management credentials never reach public clients; public release identifiers and session tokens are opaque, purpose-bound, revocable, and non-enumerable.
- Validation runs server-side against an immutable release and supported schema vocabulary. Client validation is usability only.
- Logic evaluation is typed, bounded, deterministic, cycle-free, and contains no runtime code execution or network access.
- File uploads use private direct-upload grants, strict size/type counts, content sniffing, malware quarantine, image/document hardening, and short-lived authorized reads.
- Free-text and metadata are escaped for every output context. CSV/XLSX-style exports neutralize cells beginning with `=`, `+`, `-`, or `@` and record the transformation.
- Webhook clients prevent SSRF, DNS rebinding, redirect escape, oversized responses, and unbounded retry storms.
- Field-level purpose, privacy, retention, analytics, and model classes are enforceable in query projections, exports, integrations, logs, and AI context.
- The public renderer meets WCAG 2.2 AA goals for labels, instructions, focus, errors, keyboard operation, zoom/reflow, contrast, status announcements, and reduced motion.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| FRM-001 | Two workspaces with identical form slugs, field keys, respondent emails, and submission values cannot read, validate against, mutate, search, summarize, export, resume, or infer each other's data through web, HTTP, CLI, MCP, worker, token, or file paths. |
| FRM-002 | A submission pinned to release N continues to validate and render under N after release N+1 changes types, required fields, logic, copy, and outcomes. |
| FRM-003 | An unsupported schema keyword, duplicate/recycled field key, dangling logic reference, cycle, unreachable required field, or unsafe expression prevents publication with a structured error. |
| FRM-004 | A client that hides a required field or fabricates visibility state cannot bypass server-side logic and validation. Invalid submission creates no submitted row, delivery event, upload claim, or analytics count. |
| FRM-005 | Two finalization requests with the same workspace/release/idempotency key produce one logical submission, one finalization event, and one set of downstream events. |
| FRM-006 | A partial-save token reads one session only, expires/revokes correctly, does not reveal contact existence, and cannot be upgraded into submit, export, or management authority. |
| FRM-007 | A required upload cannot finalize until clean; a malicious, mismatched, oversized, or quarantined upload remains private and creates no model or downstream delivery job. |
| FRM-008 | Post-submission correction preserves the original answer, actor, reason, release, and delivery history and emits a new versioned correction event. |
| FRM-009 | Public prefill accepts only the signed field allowlist and expiry; unsigned query parameters cannot inject hidden answers or restricted PII. |
| FRM-010 | A response quota race accepts no more than the configured limit, returns explicit results, and never stores an unacknowledged submitted response. |
| FRM-011 | Tabular export protects formula-leading cells while preserving original typed values in the versioned JSON export and records the protection applied. |
| FRM-012 | Signed webhook retries are idempotent; private, loopback, metadata, credential-bearing, redirect-escape, and DNS-rebinding destinations receive no request. |
| FRM-013 | AI summaries cite the exact query clock, filters, denominator, release and allowed result/submission identifiers; missing and skipped answers remain distinct and unsupported claims fail validation. |
| FRM-014 | A generic field intended for a password, payment card, authentication secret, protected health record, biometric template, or government identity document cannot be published. |
| FRM-015 | Rights deletion removes eligible values, files, indexes, caches, and tokens; explicit exceptions remain visible, and a restore/reindex cannot resurrect deleted data. |
| FRM-016 | CLI and MCP schema validation, submission validation, publication, correction, query, and export preview return the same versions, hashes, errors, audit identifiers, redactions, and permission failures as HTTP. |
| FRM-017 | With AI and every external provider disabled, users can draft/publish forms, validate/finalize submissions, inspect results, correct, export, and enforce retention/deletion. |
| FRM-018 | Backup/restore preserves releases, schema hashes, typed answers, corrections, quarantines, idempotency, token revocations, delivery attempts, retention clocks, and deletion tombstones. |
| FRM-019 | Keyboard-only and screen-reader testing can navigate branching pages, understand required fields and notices, upload safely, recover from errors, save/resume, submit, and request correction or withdrawal. |

## Explicitly deferred

- Payment-card entry, bank authorization, checkout, deposits, refunds, or tax collection.
- Electronic signatures, notarization, identity proofing, legal attestations, or contract execution.
- Password/secret collection, protected-health-record workflows, biometrics, background checks, or government-ID processing.
- Arbitrary customer JavaScript/CSS/HTML, executable templates, plugins, SQL, or network calls inside a form.
- A copied question/template marketplace, global respondent graph, or cross-customer benchmarking database.
- Autonomous AI interviews, scoring, eligibility decisions, or alteration of respondent data.
