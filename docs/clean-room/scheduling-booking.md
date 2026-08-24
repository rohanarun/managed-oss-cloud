# Scheduling and booking module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `schedule` |
| Working category | Scheduling and booking operations |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for many hosts, calendar connections, routing rules, public domains, webhook volume, or long booking history |
| License target | Original first-party source under MIT |
| Primary outcome | A team can publish reliable availability, let an invitee reserve an eligible slot, and preserve an explainable record of every scheduling change without double-booking a host. |

This module coordinates time. It is not a payment processor, clinical-triage system, legal appointment service, or guarantee that an external calendar is current. A customer must be able to operate an internal schedule and export standard calendar data without configuring any model or external provider.

## Scope

In scope are host/resource availability, schedule revisions, free/busy normalization, public event releases, deterministic team routing, slot previews, conflict-safe booking/rescheduling/cancellation, scoped invitee access, provider reconciliation, signed lifecycle webhooks, iCalendar export, reporting, retention, and deletion. External calendar, conferencing, email, and anti-abuse systems are customer-selected adapters around the original scheduling ledger.

Payments, regulated intake, legal or clinical prioritization, provider impersonation, arbitrary booking-page code, and autonomous model control are outside the module. The final section records additional deferred work.

## Public behavioral research record

Research sources establish public behavior and interoperability only. They are not implementation dependencies.

- [Cal.com availability documentation](https://cal.com/help/availabilities/set-up-your-availability) describes recurring hours, dated overrides, time zones, and multiple daily windows.
- [Cal.com booking API documentation](https://cal.com/docs/api-reference/v2/bookings/create-a-booking) publicly documents booking inputs, duration selection, metadata, conflict handling, and host-only overrides.
- [Cal.com routing-form documentation](https://cal.com/docs/api-reference/v2/orgs-routing-forms/create-routing-form-response-and-get-available-slots) demonstrates that intake answers can select an event or host before slots are returned.
- [Cal.com webhook documentation](https://cal.com/help/webhooks) describes lifecycle notifications for booking, rescheduling, cancellation, and meetings, plus webhook-secret and destination restrictions.
- [Cal.diy MIT license](https://github.com/calcom/cal.diy/blob/main/LICENSE) is the official current license record for that public project.
- [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html) defines the iCalendar representation for events, recurrence, time zones, and free/busy data.
- [Google Calendar FreeBusy API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) is one public provider contract for retrieving bounded busy intervals.

No Cal.com or Cal.diy source, schema, migrations, route names, tests, slot algorithm, user-interface copy, visual design, templates, examples, assets, or generated bundles may be used. The module is not a fork or compatibility claim.

## Clean-room boundary

### Permitted inputs

- This specification and the standards and public documentation linked above.
- Official provider documentation for a customer-selected calendar, conference, email, or webhook service.
- IANA time-zone data and general-purpose permissively licensed date/time libraries after dependency review.
- Customer-authored schedules, event descriptions, intake questions, routing policies, messages, and retention rules.
- Independently authored black-box vectors for recurrence, time-zone conversion, interval overlap, and idempotency.

### Prohibited inputs

- Reference-product source, schemas, migrations, internal endpoints, fixtures, snapshots, tests, queue designs, or implementation-specific algorithms.
- Reference-product layouts, wording, icons, templates, default event names, emails, or brand assets.
- Calendar credentials in model prompts, logs, booking receipts, client bundles, or public URLs.
- Silent conflict overrides, fabricated availability, or claims that an external provider accepted an event without provider evidence.
- Default workflows for collecting payments, protected health information, government identifiers, or legal-case details.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage members, domains, retention, provider connections, exports, deletion, and production policy. |
| Scheduling admin | Manage hosts, schedules, event types, routing policies, templates, and webhooks. |
| Host | Manage assigned availability, view own bookings, and approve privileged changes affecting own calendar. |
| Coordinator | View assigned schedules, create or change bookings on behalf of invitees, and resolve connector failures. |
| Analyst | Read aggregate utilization and booking outcomes without private intake answers or external calendar details. |
| Invitee | Read a published event release, preview eligible slots, create one booking, and use scoped tokens to change that booking. |
| Runtime integration | Read signed availability manifests or invoke narrowly scoped booking operations for an approved event release. |
| Auditor | Read immutable publication, booking, connector, webhook, access, export, and deletion evidence. |

Public invitees cannot enumerate hosts, workspaces, bookings, calendar connections, other attendees, or unavailable-calendar event details. Production publication, calendar credential management, conflict override, bulk cancellation, raw export, and deletion require privileged scopes.

## Original data requirements

The implementation owns a PostgreSQL schema named `schedule`. Provider-specific payload fragments may use bounded JSON columns, but the scheduling system of record is typed.

### `host`

- Workspace-scoped person or reservable resource with display name, stable key, locale, home IANA time zone, active state, and optional core-member reference.
- A host need not be a login identity; access to the host still requires an explicit workspace assignment.
- Retirement prevents new assignments but does not erase booking history.

### `schedule` and `schedule_revision`

- Schedule name, owner, default time zone, lifecycle state, and monotonically increasing revisions.
- A revision contains weekly availability windows, dated overrides, exclusions, minimum notice, booking horizon, buffers, slot interval, and effective range.
- Published revisions are immutable. A booking records the exact revision used for slot eligibility.
- A local wall time is never stored without its IANA time-zone identifier and resolved UTC instant or recurrence context.

### `busy_source` and `busy_interval`

- A source identifies an internal booking ledger, manually entered block, imported iCalendar feed, or customer-authorized provider calendar.
- Each normalized interval records source, provider version or sync cursor, start/end instants, observed time, availability classification, and privacy-safe evidence hash.
- Titles, descriptions, attendees, and conference URLs from an external calendar are excluded unless a separately authorized workflow needs them.
- A sync batch is immutable; later reconciliation appends a new observation and updates the active projection.

### `event_type` and `event_release`

- Workspace-authored name, description, host pool, allowed durations, location modes, intake schema, confirmation policy, schedule reference, routing-policy reference, and lifecycle state.
- States: `draft`, `approved`, `published`, `paused`, `retired`.
- A public release is immutable, domain-bound, content-addressed, and references exact schedule, routing, intake, and message versions.
- Publication cannot enable host conflict or out-of-bounds overrides for public callers.

### `routing_policy`

- Versioned ordered predicates over allowlisted intake answers and explicit candidate hosts.
- Outcomes may select an event release, an eligible host set, a deterministic assignment strategy, a public message, or a safe external redirect approved by the workspace.
- A preview records matched rule identifiers, candidate set, exclusions, and the eventual tie-break reason.
- Protected traits and inferred sensitive attributes are not valid routing inputs.

### `slot_snapshot`

- Event release, requested time range, viewer time zone, candidate hosts, exact schedule revisions, busy-source cursors, generated slots, expiration, and content hash.
- A snapshot is evidence for a preview, not a reservation. Booking always revalidates current eligibility transactionally.
- Public responses reveal only eligible start/end times and explicitly approved host labels.

### `booking`

- Workspace, event release, assigned host/resource set, start/end instants, original viewer and host time zones, duration, lifecycle state, invitee reference, intake-answer reference, source, idempotency key, predecessor/successor links, provider status, and version.
- States: `pending_verification`, `requested`, `confirmed`, `rejected`, `canceled`, `completed`, `no_show`, `failed`.
- State changes append `booking_event` rows. An issued booking's original facts are not rewritten in place.
- Active bookings for an exclusive host/resource cannot overlap. Enforcement is transactional at the database boundary, not an application-only precheck.

### `attendee` and `intake_answer`

- Attendees contain only fields explicitly required by the published release, with field-level privacy and retention classes.
- Answers reference stable intake-field identifiers and the exact release. Corrections append versions.
- Passwords, payment cards, access tokens, health records, or unrestricted secrets are invalid field purposes.

### `booking_access_token`

- Purpose-bound, booking-bound, expiring token digest for view, confirm, reschedule, or cancel operations.
- Raw tokens are returned only at issuance, never stored, logged, or included in model context.
- Rotation or use records an audit event; cancellation and rescheduling tokens cannot enumerate other bookings.

### `provider_connection` and `provider_operation`

- Customer-owned credential reference, granted scopes, external account label, sync cursor, health state, last success, and revocation evidence.
- Secrets live in the core secret store. The scheduling schema stores only opaque references.
- Every external read or write records request purpose, idempotency key, redacted result, provider identifier, timestamps, and retry state.
- Provider success is recorded only from a validated response or later reconciliation, never inferred from queue completion.

### `webhook_subscription` and `webhook_delivery`

- Workspace/event scope, approved HTTPS destination, event allowlist, secret reference, state, and retry policy.
- Deliveries use an immutable payload version, event identifier, signature metadata, attempt history, and terminal result.
- Destination validation rejects loopback, private, link-local, metadata, non-HTTP, credential-bearing, and DNS-rebinding targets under the hosted policy.

## Required workflows

### 1. Configure host availability

1. An admin or host creates a schedule in an explicit IANA time zone.
2. Weekly windows, dated exceptions, buffers, notice, horizon, and slot interval form a draft revision.
3. Deterministic validation rejects overlaps, invalid durations, nonexistent local times without an explicit resolution, excessive horizons, and missing fallback behavior.
4. An authorized actor publishes the exact revision hash.
5. Existing bookings remain bound to the revision and instants under which they were created.

### 2. Publish an event

1. An admin selects hosts/resources, durations, schedule, location modes, required intake fields, confirmation mode, and routing behavior.
2. A preflight verifies domain ownership, active hosts, compatible schedules, safe redirects, field-purpose declarations, and available confirmation delivery.
3. An approver publishes an immutable event release.
4. The public surface exposes only the release's approved content and a stable opaque identifier or slug.
5. Editing creates a new release; it does not rewrite a booked invitee's contract.

### 3. Preview availability

1. A caller supplies an event release, bounded range, viewer IANA time zone, duration, and routing answers when required.
2. The server validates the release and routing input, resolves candidate hosts, expands schedule rules, normalizes busy intervals, applies buffers/notice/horizon, and intersects required resources.
3. The server returns only currently eligible slots plus snapshot hash and expiration.
4. Ambiguous and nonexistent daylight-saving wall times have explicit, tested handling.
5. A preview never holds or guarantees a slot.

### 4. Create a booking

1. The invitee selects a previewed slot, submits the published intake fields, accepts the stated data notice, and supplies an idempotency key.
2. The server re-evaluates release, route, availability, current busy intervals, capacity, and policy inside the booking transaction.
3. It atomically reserves each exclusive host/resource or returns a conflict without a partial booking.
4. The module creates booking and event evidence, then queues confirmation and provider operations through the outbox.
5. External calendar or email failure is shown separately from the durable internal booking state and remains retryable.

### 5. Reschedule or cancel

1. The invitee presents a purpose-bound token, or an authorized coordinator selects the booking.
2. Rescheduling previews eligible replacements while treating the original interval according to the stated policy.
3. Confirmation atomically creates a successor and changes the predecessor state so no two active reservations remain.
4. Cancellation appends a reason-classified event and releases internal capacity exactly once.
5. Provider updates, messages, and webhooks reference the immutable booking event and reconcile independently.

### 6. Route across a team

1. Allowlisted answers are validated against the event release.
2. The versioned routing policy produces a candidate set and explicit exclusions.
3. Deterministic assignment considers eligibility and the configured strategy; a random strategy must use a stored seed and receipt.
4. The preview and booking preserve the selected rule, candidates, and tie-break evidence.
5. AI may explain or propose a policy but is not in the live routing decision path.

### 7. Reconcile calendars and delivery

1. A bounded connector job fetches free/busy data using the minimum authorized scopes.
2. The job records cursor, observation time, redacted errors, and the active projection it changed.
3. Calendar-write and message attempts use stable idempotency keys and bounded retries.
4. Reconciliation can distinguish accepted, rejected, unknown, and later-missing provider state.
5. Revoked credentials stop new provider work without deleting internal bookings.

### 8. Export, retain, and delete

1. Authorized users preview a bounded export with fields, bookings, attendees, events, and connector evidence included.
2. Exports use stable UTC instants, original time-zone fields, and portable iCalendar or versioned JSON where applicable.
3. Retention jobs delete or anonymize eligible invitee data while preserving non-identifying capacity and audit evidence.
4. Provider deletions are explicit connector operations with receipts; local deletion never claims remote deletion without evidence.
5. Backup/restore preserves overlap safety, revision lineage, tokens' revoked state, and outbox idempotency.

## Public surfaces

- A custom-domain event page reads one published release and supports keyboard and screen-reader slot selection.
- A bounded availability endpoint accepts release, date range, time zone, duration, and validated routing answers; it never exposes raw busy entries.
- A booking endpoint accepts only fields declared by the exact release, an anti-abuse proof, and an idempotency key.
- Purpose-bound token endpoints support view, verification, reschedule preview/commit, and cancellation for one booking.
- Public iCalendar downloads contain only the invitee's booking and approved fields.
- Public endpoints use uniform non-enumerating errors, rate and range limits, origin/domain binding, request-size limits, structured accessibility errors, and replay protection.
- Custom HTML, JavaScript, arbitrary templates, redirect targets, or webhook URLs cannot be supplied through public requests.

## AI contract

### Allowed AI actions

- Draft an availability pattern, event description, intake form, routing proposal, or reminder copy for review.
- Explain why a requested interval was unavailable using cited schedule, buffer, and privacy-safe busy evidence.
- Summarize utilization, cancellation, or no-show facts from exact query results with definitions and time ranges.
- Suggest schedule gaps, routing imbalances, or stale event releases as proposals.
- Translate customer-authored public copy while preserving required fields and marking the result unreviewed.

### Forbidden AI actions

- Create, confirm, reject, reschedule, cancel, or mark attendance without an explicit authorized deterministic action.
- Override conflict, notice, capacity, horizon, domain, or approval checks.
- Invent a slot, attendee fact, meeting link, provider acceptance, delivery receipt, or reason for cancellation/no-show.
- Route using protected traits, inferred sensitivity, sentiment, perceived importance, or undisclosed scoring.
- Receive provider secrets, raw access tokens, private calendar titles/descriptions, or unnecessary attendee data.
- Send messages, publish event releases, or change permissions directly.

AI outputs store their allowlisted source identifiers, query clock, model metadata, prompt-template version, proposal diff, reviewer outcome, and any unsupported fields. Live slot generation and booking commits are deterministic and model-independent.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite schedule host create --file host.json
supersuite schedule schedule create --timezone America/New_York --file availability.json
supersuite schedule schedule publish --revision REVISION_ID --confirm-hash SHA256
supersuite schedule event publish --event EVENT_ID --confirm-hash SHA256
supersuite schedule availability preview --event EVENT_RELEASE_ID --from 2026-09-01 --to 2026-09-08 --timezone Europe/London
supersuite schedule routing preview --event EVENT_RELEASE_ID --answers answers.json
supersuite schedule booking create --event EVENT_RELEASE_ID --slot SLOT_JSON --idempotency-key KEY --file invitee.json
supersuite schedule booking reschedule --booking BOOKING_ID --slot SLOT_JSON --confirm-version VERSION
supersuite schedule booking cancel --booking BOOKING_ID --reason invitee_request --confirm-version VERSION
supersuite schedule booking export --from 2026-09-01 --to 2026-09-30 --format ical
```

Required MCP tools:

- `schedule_host_list`
- `schedule_schedule_draft`
- `schedule_schedule_publish`
- `schedule_event_draft`
- `schedule_event_publish`
- `schedule_availability_preview`
- `schedule_routing_preview`
- `schedule_booking_create`
- `schedule_booking_get`
- `schedule_booking_reschedule_preview`
- `schedule_booking_reschedule`
- `schedule_booking_cancel`
- `schedule_connector_health`
- `schedule_booking_export`
- `schedule_unavailability_explain`

Publication, connector mutation, conflict override, bulk change, raw export, and deletion require human-only scopes and exact version/hash confirmation. MCP callers receive the same conflict, stale-version, field-redaction, and permission behavior as HTTP and CLI callers.

## Resource and plan contract

- Starter supports normal small-business hosts, schedules, event releases, booking pages, internal busy blocks, and bounded connector synchronization within pooled quotas.
- Scale is recommended for many hosts/calendars, dense team routing, high public traffic or webhook volume, many custom domains, frequent synchronization, or long event history.
- Fleet is appropriate only when capacity measurements demonstrate sustained high concurrency, large resource pools, or isolation requirements; it does not unlock a different scheduling truth model.
- Calendar, conferencing, email/SMS, object-storage, anti-abuse, and outbound webhook usage selected by the customer is separately metered or customer-funded.
- Slot previews have bounded date ranges and cache lifetimes. Booking commits, not cached previews, own concurrency correctness.

## Security and privacy requirements

- PostgreSQL row-level security and explicit workspace/host assignments protect every administrative and booking query.
- Exclusive-resource overlap is enforced in a serializable transaction or database exclusion constraint covering every active booking state.
- Public identifiers and tokens are high entropy; raw tokens and provider secrets are never logged or returned after issuance.
- External calendar ingestion defaults to free/busy intervals only and discards titles, descriptions, attendees, and conference details.
- Public intake fields have declared purpose, visibility, retention, validation, and model-exposure classes.
- Calendar and webhook network clients resist SSRF, DNS rebinding, redirect escape, oversized responses, and unbounded retries.
- Confirmation and reminder delivery honors the Notify module's consent, preference, quiet-hour, suppression, and receipt model when linked.
- Exports are bounded, encrypted at rest, short-lived, audited, and protected against spreadsheet formula injection when tabular.
- Aggregate reporting exposes query definitions, clocks, missing connector data, and small-cohort suppression.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| SCH-001 | Two workspaces containing the same host email, event slug, and invitee email cannot read, route, book, change, search, export, or infer each other's records through web, HTTP, CLI, MCP, worker, token, or file paths. |
| SCH-002 | Weekly availability spanning a daylight-saving gap and overlap produces the documented UTC instants with no duplicate slot identifiers or silently shifted wall times. |
| SCH-003 | Two concurrent requests for the same exclusive host interval produce exactly one active booking; the loser receives a conflict and no attendee, outbox, or provider side effects. |
| SCH-004 | Retrying a timed-out booking request with the same workspace/event/idempotency key returns the same booking and creates no second reservation or delivery. |
| SCH-005 | A slot preview made before a new busy interval is added cannot bypass transactional revalidation; booking fails without partial state. |
| SCH-006 | A public request setting host-only conflict or out-of-bounds fields is rejected or ignored safely and can never create an ineligible booking. |
| SCH-007 | Editing a schedule or event after publication creates a new revision; existing bookings retain their exact event, schedule, intake, time-zone, and routing evidence. |
| SCH-008 | Rescheduling atomically leaves one active successor, a non-active predecessor, and preserved lineage even when provider delivery is temporarily unavailable. |
| SCH-009 | Canceling twice is idempotent: capacity is released once, one logical cancellation exists, and retries return the original result. |
| SCH-010 | A free/busy connector response affects eligibility but its private title, description, attendee list, and meeting URL are absent from slot responses, logs, AI context, and analyst reports. |
| SCH-011 | Route evaluation returns the same candidate set and assignment for the same policy revision, answers, busy snapshot, and stored seed; a protected-trait field cannot be published as a predicate. |
| SCH-012 | Booking-access tokens are purpose-bound, expire and revoke correctly, reveal one booking only, and produce uniform errors for invalid workspace, booking, and token combinations. |
| SCH-013 | Webhook delivery signatures verify over exact bytes; loopback, private, metadata, credential-bearing, redirect-escape, and DNS-rebinding destinations fail before a request is sent. |
| SCH-014 | A queued external-calendar write is not reported as accepted until validated provider or reconciliation evidence exists; unknown outcomes remain visibly unknown and retry safely. |
| SCH-015 | An AI explanation cites exact privacy-safe schedule/buffer/busy evidence and cannot create, mutate, publish, message, or override a booking through AI scope. |
| SCH-016 | CLI and MCP availability previews and booking mutations return the same slots, hashes, versions, conflicts, audit identifiers, and permission failures as HTTP. |
| SCH-017 | Backup/restore preserves schedule/event revisions, active interval exclusion, booking lineage, idempotency records, token revocations, provider cursors, and pending outbox work. |
| SCH-018 | With AI and all external providers disabled, users can publish internal availability, create/change bookings, download iCalendar data, export evidence, and enforce retention. |
| SCH-019 | Keyboard-only and screen-reader users can understand an event, select a time zone and slot, correct validation errors, submit, verify, reschedule, and cancel. |

## Explicitly deferred

- Payment collection, deposits, refunds, tax calculation, or financial settlement.
- Clinical triage, emergency scheduling, medical-record intake, or regulated care decisions.
- Legal-service conflict checks, government appointment authority, or identity-document collection.
- Autonomous scheduling by a model without exact user confirmation and deterministic conflict checks.
- A proprietary conference service, email/SMS provider, global holiday database, or copied time-zone implementation.
- Arbitrary custom booking-page code or unreviewed third-party marketplace plugins.
