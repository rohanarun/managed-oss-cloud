# Premium business suite threat model

## Security objectives

The primary objectives are tenant confidentiality, authorization integrity, replay-safe mutation, non-repudiable consequential actions, exact accounting, and grounded model output. Availability is important, but a failed-closed request is preferred to a cross-tenant read, silent send, unreviewed file action, unbalanced posting, or fabricated AI claim.

## Assets

- Tenant planning records and dependency graphs.
- File object keys, hashes, retention policies, and private share material.
- Team messages, redaction history, topics, and decisions.
- Parties, price snapshots, invoices, journals, payment facts, and balances.
- Prompt content, model identity, evidence sets, model outputs, reviews, and agent allowlists.
- Idempotency outcomes and append-only audit receipts.
- Authoritative plan entitlements and resource quotas.

## Trust boundaries

1. Browser, CLI, and MCP inputs are untrusted.
2. Authentication resolves an actor and tenant before premium dispatch.
3. Subscription state resolves the plan before module access.
4. The application runtime creates tenant-scoped records and receipts.
5. PostgreSQL must independently enforce the same tenant through forced row-level security.
6. Object storage contains bytes outside the metadata engine.
7. Model workers receive only approved evidence projections.
8. External delivery or accounting connectors run after approval and idempotency checks.

## Threats and controls

### Cross-tenant object reference

Threat: an attacker supplies another tenant's record ID to an otherwise authorized action.

Controls: tenant ID exists only in authenticated context; every lookup compares the stored tenant; records cannot be fetched through an input-supplied tenant; evidence resolution repeats the ownership check for every ID; tests exercise cross-tenant issue creation and direct reads. The PostgreSQL adapter must add forced RLS rather than relying only on application checks.

### Confused plan deputy

Threat: a Scale customer calls Fleet accounting or AI actions by placing `plan: "fleet"` in JSON.

Controls: action schemas reject unknown fields; plan lives outside action input; dispatch rejects modules before creating a record. The host integration must populate the plan only from verified subscription state.

### Duplicate or changed retry

Threat: network retries duplicate a message, file share, journal, payment, or model run; an attacker reuses a key with altered input.

Controls: every mutation requires an idempotency key scoped by tenant, module, and action; exact input hash replays the original snapshots; changed input fails. Dry runs do not consume mutation keys.

### Approval substitution

Threat: a caller supplies someone else's approval or a stale approval for a consequential action.

Controls: approved actor must equal authenticated actor; approval must be affirmative, reasoned, and recently timestamped. An alternative dry run performs no mutation or external effect. Exact preview hashes bind message, share, model, invoice, and journal approval to reviewed content.

### File exfiltration or deletion

Threat: a model receives storage paths, a share changes after review, plaintext token material is persisted, or retention is bypassed.

Controls: model requests include checksum and record ID but no object key or bytes; shares pin version, checksum, permission, and expiry; stored share data contains only a token hash; legal hold and future retention block deletion; deletion is soft and emits an object-deletion requirement for a separately authorized storage worker. Every immutable Drive version and e-sign document is registered in the tenant-scoped `suite_storage_objects` ledger under the workspace mutation lock. Registered size and identity cannot be lowered, overwritten, or deleted; object-store reconciliation records matches and mismatches without replacing the registered byte count.

Residual risk: registered metadata is intentionally reported as unverified until a host object-store adapter performs an exact-version HEAD request. That adapter must also enforce tenant prefixes, server-side encryption, malware scanning, byte quotas, and deletion receipts. The domain engine cannot prove those controls by metadata alone.

### Message spoofing or silent model send

Threat: content changes after review or a generated digest is sent as a human.

Controls: posting requires the exact topic-version/body preview hash and recent actor approval; model summaries are queued records with null output; digest metadata forbids automatic send; redaction preserves the original body hash and reason.

### Accounting corruption

Threat: floating-point rounding, unbalanced entries, payment over-application, changed invoices, or AI posting financial facts.

Controls: prices and amounts use safe integer minor units; every journal line has exactly one positive debit or credit; total debit must exactly equal total credit; posted journals are immutable content-addressed snapshots; payments require an open invoice, exact currency, and amount no greater than balance; variance AI is explicitly non-posting.

Residual risk: tax, exchange rates, period close, jurisdictional numbering, segregation of duties, and external bank reconciliation need separate specifications before production accounting claims are made.

### Prompt injection and fabricated model output

Threat: evidence content directs a model to ignore policy, a provider response omits provenance, or an agent mutates tools autonomously.

Controls: prompts are immutable content-addressed policy; runs pin exact attached evidence and model ID; queued output is null; result recording requires reviewer identity, confidence, selected evidence, and claim-level citations; unsupported evidence fails; agent action names must exist in the premium MCP registry; automatic mutation is false and each proposed consequential action requires its own approval.

Residual risk: citations prove declared provenance, not factual truth. A production worker should add content-isolation delimiters, output-schema validation, per-model sandboxing, model digest verification for local weights, and reviewer UX that opens each cited source.

### Secret injection

Threat: provider keys, bearer tokens, passwords, cookies, or private keys enter records, prompts, receipts, or logs.

Controls: strict schemas reject unknown fields; recursive input inspection rejects common secret-bearing field names and executable payloads; model identifiers are names, not credentials; private share output is excluded from receipts. The integration layer must also redact infrastructure logs and retrieve provider credentials only inside the worker.

### Denial of service

Threat: oversized JSON, deep structures, huge evidence lists, excessive model runs, or object bytes exhaust a shared tenant database.

Controls: input depth, byte size, string size, list count, point, quantity, amount, and action-specific bounds; plan-level CPU, memory, storage, and concurrency profiles; model runs remain queued. Production must add tenant rate limits, queue backpressure, storage quotas, statement timeouts, and cancellation.

## Required production evidence

Before enabling hosted external effects, produce:

- forced-RLS integration tests with distinct runtime and migration roles;
- concurrent idempotency tests against PostgreSQL;
- connector tests proving preview hash and approval survive queue handoff;
- object-store policy and deletion receipt tests;
- model-worker tests proving no object key or provider secret enters prompt context;
- accounting property tests across safe integer boundaries;
- end-to-end CLI and MCP tests for every premium action and plan denial;
- backup and tenant-scoped restore exercises for records and audit receipts.
