# Notifications module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `notify` |
| Working category | Transactional and in-product notifications |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for high event volume, many providers, large digests, or extended delivery history |
| License target | Original first-party source under MIT |
| Primary outcome | A product team can emit one typed event and deliver preference-aware, auditable notifications through customer-owned providers. |

The module coordinates delivery. It does not include SMS, email, push, or chat transport charges, does not operate an undisclosed shared sender identity, and must distinguish accepted-by-provider from delivered-to-recipient.

## Public behavioral research record

- [Novu public repository and README](https://github.com/novuhq/novu) describes a unified API for in-app, email, SMS, push, and chat channels; workflows; conditions; digests; templates; an inbox; and subscriber preferences.
- [Novu MIT core license](https://github.com/novuhq/novu/blob/next/LICENSE-MIT) is the official permissive core license record. The repository also contains separately licensed enterprise directories.
- [CloudEvents specification](https://github.com/cloudevents/spec) is a vendor-neutral public event-envelope reference. Compatibility, if implemented, uses the standard rather than Novu internals.

No Novu source, schema, workflow design, endpoint names, templates, provider code, UI, copy, tests, or assets may be copied. Provider adapters are implemented only from each provider's official API documentation.

## Clean-room boundary

### Permitted inputs

- The public behaviors and open standard summarized here.
- Official provider API, webhook, authentication, and rate-limit documentation.
- Customer-authored templates, sender identities, preference policies, and event schemas.
- General queue, outbox, idempotency, retry, and dead-letter patterns.

### Prohibited inputs

- Reference source, internal event names, database design, workflow representation, UI, provider abstraction, or tests.
- Sending through credentials or domains not verified and authorized by the customer.
- Fabricated delivery, open, click, unsubscribe, or provider-health events.
- Dark-pattern preference UI, hidden required marketing consent, or bypass of a recipient's effective preferences.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage providers, sender identities, retention, members, event keys, and exports. |
| Notification designer | Define event schemas, templates, workflows, localization, and test fixtures. |
| Publisher | Approve and activate exact workflow/template versions. |
| Operator | Inspect runs, retry eligible failures, pause providers/workflows, and manage incidents. |
| Analyst | Read aggregate delivery metrics without provider secrets or message bodies by default. |
| Product service | Emit authorized typed events with idempotency keys. |
| Subscriber | Read own inbox and manage allowed preferences. |

Provider credentials, sender verification, workflow publication, broadcast execution, forced preference changes, replay, and raw payload export are privileged.

## Original data requirements

The implementation owns a PostgreSQL schema named `notify`.

### `subscriber`

- Workspace-scoped external key, locale, time zone, approved profile fields, lifecycle state, and optional links to CRM/core contacts.
- External keys are unique only within a workspace.
- Profile fields are allowlisted per event/template and not automatically sent to AI.

### `channel_endpoint`

- Subscriber, channel type, normalized address/token reference, verification state, validity state, source, and timestamps.
- Sensitive addresses/tokens are encrypted or stored in the core secret service and masked on read.

### `topic`

- Stable workspace-defined key, description, default preference, required/optional classification, and allowed channels.
- Marketing and transactional topics remain explicitly distinct.

### `preference`

- Subscriber/topic/channel decision, source, policy version, effective time, expiration where applicable, and audit evidence.
- A preference change is append-only at the audit layer and immediately affects newly evaluated events.

### `event_schema`

- Stable event key, version, JSON Schema, allowed sensitive fields, retention class, example fixture authored for the workspace, and lifecycle state.
- Published schema versions are immutable.

### `event`

- Workspace, key/version, subject/subscriber references, payload, occurrence time, idempotency key, source, trace/correlation IDs, and ingestion state.
- Events are immutable after acceptance; invalid events are rejected before queueing.

### `template`

- Topic/channel/locale, subject/title/body component tree, safe variables, fallback behavior, version, review state, and rendering hash.
- Templates are data, not arbitrary executable code.
- States: `draft`, `approved`, `published`, `retired`.

### `workflow`

- Trigger event key/version range, recipient resolution, deterministic conditions, ordered steps, delays, digest rules, quiet hours, cancellation rule, version, and state.
- Published versions are immutable; new events bind to one exact version.

### `provider`

- Channel, encrypted credential reference, verified sender, capabilities, rate/concurrency policy, health, region, and configuration version.
- A provider can be paused without editing workflows.

### `notification_run`

- Event, workflow version, subscriber, topic, evaluation trace, state, cancellation reason, and timestamps.
- States: `queued`, `waiting`, `suppressed`, `rendering`, `sending`, `completed`, `partial`, `failed`, `canceled`.

### `delivery_attempt`

- Run/step, channel, provider/config version, rendered content hash, attempt number, request time, provider message ID, response class, accepted time, delivered/bounced/failed time, and diagnostic code.
- `accepted`, `delivered`, `read`, and `clicked` are separate evidence states.

### `digest_bucket`

- Subscriber, workflow step, deterministic window, ordered event references, close time, and state.
- The same event cannot enter the same bucket twice.

### `inbox_item`

- Subscriber, run, safe rendered content, read/archive state, action links, created/expiry times, and content version.

### `provider_receipt`

- Signed webhook ID, provider, received time, verified payload hash, normalized event, and processing outcome.

## Required workflows

### 1. Connect a provider and sender

1. An owner selects a channel/provider and submits credentials through a one-way secret form.
2. The module validates only the requested capability using official provider behavior.
3. Sender-domain/address verification state is imported or challenged.
4. The provider remains test-only until verification succeeds.
5. Health and quota are visible without exposing credentials.

### 2. Define an event and workflow

1. A designer creates a versioned JSON event schema.
2. The workflow selects recipients, topic, conditions, steps, delays, digests, quiet hours, and cancellation behavior.
3. Templates are authored per channel/locale with safe variables and explicit fallback.
4. Deterministic preflight validates schema/template variables, reachable fallback, provider capability, preference topic, and unsafe links.
5. A publisher approves exact hashes and activates the version atomically.

### 3. Ingest an event

1. A product service authenticates with event-only scope and supplies event version plus idempotency key.
2. The payload is validated and size/field limits are enforced.
3. Durable acceptance occurs before asynchronous dispatch.
4. The response says accepted/replayed/rejected; it never claims recipient delivery.

### 4. Evaluate and dispatch

1. A leased worker binds the event to one published workflow version.
2. It resolves recipients, effective preferences, quiet hours, conditions, and cancellation rules deterministically.
3. Each run stores why a step was selected, delayed, digested, or suppressed.
4. A renderer produces channel content and a content hash from an approved template.
5. Provider calls use bounded retries, rate limits, and idempotency where supported.

### 5. Digest

1. Eligible events join a deterministic subscriber/workflow/window bucket.
2. Replayed events do not duplicate the bucket.
3. Closing leases one bucket once, renders ordered items, and creates a normal delivery attempt.
4. Empty or canceled buckets do not send.

### 6. Process delivery receipts

1. Provider webhook signatures and replay IDs are verified.
2. Normalized evidence updates the matching attempt monotonically.
3. Out-of-order delivered/bounce/read events retain raw ordering while producing a consistent current state.
4. Unknown provider message IDs are quarantined, not attached heuristically.

### 7. Subscriber inbox and preferences

1. A subscriber-authenticated client lists only that subscriber's items.
2. Read/archive mutations are idempotent.
3. Preferences show topic/channel consequences and apply immediately to new event evaluation.
4. A required operational topic cannot be turned into marketing or silently made optional through AI/template changes.

### 8. Pause, retry, and export

1. Operators can pause a provider/workflow without losing queued events.
2. Only retryable attempts can be retried, with a visible new attempt and original evidence retained.
3. Dead-letter runs expose a diagnostic and safe replay preview.
4. Authorized exports include schemas, versions, runs, attempts, and receipt provenance within retention limits.

## AI contract

### Allowed AI actions

- Draft channel-specific content and locale translations from approved factual inputs.
- Suggest concise digest summaries while preserving links to every underlying event.
- Explain failures, bounces, suppression, or poor deliverability from provider evidence.
- Propose workflow conditions or quiet-hour policies as unapproved structured drafts.
- Detect likely template-variable or tone problems before publication.

### Forbidden AI actions

- Send, broadcast, publish a workflow/template, retry delivery, change preferences, or connect a provider.
- Invent provider delivery/open/click outcomes or claim inbox placement.
- Turn optional marketing into required transactional messaging.
- Add payload fields not allowed by the published event schema.
- Receive provider secrets, device tokens, full recipient lists, or unrestricted event payloads.

AI-generated content is versioned and requires the same validation/approval as human-authored content. Deterministic rendering owns variable substitution and escaping.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite notify provider add --channel email --provider smtp
supersuite notify subscriber upsert --external-id CUSTOMER_123 --locale en-US
supersuite notify schema publish --event invoice.overdue --file schema.json
supersuite notify workflow validate --workflow WORKFLOW_ID
supersuite notify event emit --key invoice.overdue --version 1 --file event.json --idempotency-key KEY
supersuite notify run inspect --run RUN_ID
supersuite notify provider pause --provider PROVIDER_ID --reason maintenance
```

Required MCP tools:

- `notify_subscriber_get`
- `notify_preference_get`
- `notify_preference_set`
- `notify_event_validate`
- `notify_event_emit`
- `notify_workflow_get`
- `notify_workflow_draft`
- `notify_workflow_publish`
- `notify_run_get`
- `notify_delivery_retry`
- `notify_provider_health`
- `notify_report_query`

`notify_event_emit` requires an event-specific scope and idempotency key. `notify_workflow_publish` requires an approved exact version. `notify_delivery_retry` rejects non-retryable or already successful attempts.

## Resource and plan contract

- Starter supports ordinary transactional/inbox notification workflows within pooled quotas.
- Scale is recommended for high event rates, numerous providers, large digests, or extended logs.
- Email, SMS, push, chat, telephone, model, and dedicated-IP costs are customer-owned or itemized usage.
- Workspace/provider concurrency, burst, daily send, and retry ceilings are explicit.
- Backpressure preserves accepted events durably and reports delay; it does not drop or falsely complete them.

## Security and safety requirements

- Event ingestion, inbox, preferences, public actions, and provider webhooks have separate credentials and scopes.
- Provider secrets and channel tokens are encrypted and redacted.
- Templates use safe typed components and context-appropriate escaping; arbitrary server-side code is forbidden.
- External links can be allowlisted and signed. Tracking is off by default and requires explicit customer configuration and disclosure.
- Suppression, unsubscribe, invalid-endpoint, and abuse data is enforced before send.
- Provider receipts are signature-verified and replay-protected.
- Logs avoid complete message bodies and recipient addresses by default.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| NOT-001 | Identical subscriber external IDs and event keys in two workspaces remain completely isolated across ingestion, inbox, preferences, runs, reports, provider receipts, CLI, and MCP. |
| NOT-002 | Emitting the same valid event with one idempotency key twice creates one immutable event and one logical workflow run. |
| NOT-003 | An invalid event schema or oversized disallowed field is rejected before durable dispatch and causes no provider call. |
| NOT-004 | A subscriber who disabled an optional topic/channel receives a stored suppression explanation and no provider request. |
| NOT-005 | Quiet hours delay a run until the subscriber's configured time zone window ends; evaluation survives process restart without duplicate send. |
| NOT-006 | Three distinct eligible events enter one digest bucket once each; replaying one event does not duplicate the rendered digest. |
| NOT-007 | Provider acceptance marks only `accepted`; `delivered` appears only after valid provider evidence and is never inferred from time elapsed. |
| NOT-008 | A forged or replayed provider webhook cannot mutate an attempt and creates a security audit event. |
| NOT-009 | A provider HTTP 429 follows bounded provider-aware backoff and does not spawn parallel attempts or mark failure as delivery. |
| NOT-010 | Pausing a provider stops new calls while preserving queued runs; resuming continues each eligible step once. |
| NOT-011 | A template containing unsafe markup or an undeclared variable fails publication preflight. |
| NOT-012 | AI-drafted content remains unapproved, cannot send, and includes only allowlisted event fields. |
| NOT-013 | Inbox authentication for subscriber A cannot retrieve, mark read, or invoke actions on subscriber B's item. |
| NOT-014 | CLI and MCP event emission reach the same HTTP path and return equivalent event, run, idempotency, and audit metadata. |
| NOT-015 | Backup restore preserves event/workflow binding, queued schedules, attempts, receipt hashes, preferences, and inbox state. |
| NOT-016 | With AI disabled, schema/workflow/template authoring, event dispatch, inbox, preferences, provider receipts, retry, and reporting work normally. |

## Implemented first slice

The shared suite currently registers this as a Starter/shared-resource module with generated CLI/MCP actions for subscriber upsert, topics, immutable event-schema publication, workflow drafting/configuration/publication, append-only preferences, event validation/emission, and unapproved workflow suggestions. The deterministic engine supports a bounded scalar JSON-schema subset, rejects secret-like fields and undeclared payload data, limits payloads to 64 KiB, accepts events idempotently, binds one published workflow version, evaluates effective preferences, and creates either a durable local inbox item or a cited suppression run.

Only the in-product `inbox` channel is executable in this slice. Event results explicitly report `providerCallStarted: false` and `delivered: false`; no customer provider is contacted and no provider secret, channel endpoint, recipient address, or token is accepted. External provider adapters, signed receipt ingestion, retries, digests, quiet-hour leases, and subscriber-authenticated public inbox routes remain separate future slices.

## Explicitly deferred

- Operating a shared bulk-email reputation service or shared SMS inventory.
- Marketing-campaign audience building, which belongs in publishing/CRM automation.
- Telephony compliance or emergency notification guarantees.
- Hidden tracking pixels, fingerprinting, or unconsented cross-site attribution.
- Arbitrary user-authored code inside templates or workflow conditions.
