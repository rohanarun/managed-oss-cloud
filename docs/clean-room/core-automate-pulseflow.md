# PulseFlow clean-room product specification

## Product boundary

PulseFlow is a first-party MIT-licensed workflow engine designed from domain requirements, not from third-party source code, UI, schemas, APIs, fixtures, or branding. It is not a compatibility clone. Its primary object is an immutable, typed workflow version rather than an editable bag of connector settings.

## Why it is better and AI-native

- Simulation and publication are distinct. Simulation never calls connectors.
- Every live run binds an event hash to an exact published workflow hash.
- Webhook envelopes are deduplicated by endpoint and delivery ID; signature verification stays at the hosting boundary.
- AI diagnoses and retry plans are cited proposals, never autonomous retries. Prompt ID, prompt version, prompt digest, requested model policy, evidence IDs, confidence, and review status are durable audit fields.
- Acyclic dependency validation, idempotency, retry budgets, and approval gates remain deterministic.

## Domain model and invariants

`workflow-version` freezes trigger schema, step graph, content hash, and version. `trigger-event` stores a signed-envelope receipt. `workflow-run` stores the exact workflow/event hashes and step outcomes. `command-receipt`, `ai-request-audit`, and `external-effect-receipt` are append-only evidence.

Step keys are unique stable keys. Dependencies reference declared steps and cannot cycle. Only an exact published content hash starts a live run. Connector execution requires an owner/admin approval and a separate executor receipt.

## CLI and MCP surface

The typed actions are `workflow-version-create`, `trigger-event-validate`, `workflow-publish`, `workflow-run-simulate`, `workflow-run-start`, `webhook-event-ingest`, `failure-diagnose`, `retry-plan-propose`, and `run-export`. MCP names use `automate_<action_with_underscores>`; every definition includes JSON Schema and a runnable `supersuite action` example.

## Threat model

- Prompt injection: records are evidence, never system instructions; only explicitly selected record IDs enter the AI boundary.
- SSRF and connector abuse: this engine never accepts provider secrets and never performs network calls itself.
- Duplicate/replayed delivery: mutation keys and webhook delivery IDs are content-bound.
- Cross-tenant reads: authorization workspace and store-owned records are checked before dereference; database integration must also enforce workspace RLS.
- Approval confusion: a live command requires actor-matching approval ID and reason; dry-run creates no connector effect.

## Import, export, and webhooks

Run export is a private canonical manifest pinned to source update time. Webhook ingestion accepts only preverified envelope metadata and hashes, never raw secrets. A future connector SDK must return provider receipts and may not mutate workflow history.

## License and provenance

New implementation code and documentation are offered under the repository MIT license. Dependency and connector licenses remain independently auditable. No third-party product assets, names, source, or trade dress are included.
