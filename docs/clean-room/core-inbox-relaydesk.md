# RelayDesk clean-room product specification

## Product boundary

RelayDesk is a first-party MIT customer conversation ledger. It is based on support jobs and safety invariants, not copied help-desk code, APIs, visual design, schemas, or branding.

## Why it is better and AI-native

- Messages are append-only chronological facts with deduplicated delivery envelopes.
- Assignment and resolution use optimistic versions, making races visible.
- Sender references are hashed on inbound ingestion; exports support explicit redaction policy.
- AI reply and summary actions cite only selected conversation/knowledge evidence, persist prompt/model/confidence/review metadata, and cannot send or resolve.
- “Approved pending executor” and provider-accepted outbound messages remain separate states.

## Domain model and invariants

`conversation` owns channel, contact, version, state, assignment, and resolution. `message` owns direction, immutable body, chronology, and delivery provenance. `sla-policy` stores whole-minute targets. Provider sends create `external-effect-receipt` only after an executor returns evidence.

Inbound messages require an open conversation. Delivery IDs deduplicate retries. Only an open thread can send a reply. Exact actor approval is mandatory for sends.

## CLI and MCP surface

Actions: `thread-open`, `message-ingest`, `thread-assign`, `sla-policy-set`, `reply-propose`, `reply-send`, `thread-summarize`, `thread-resolve`, and `conversation-export`. MCP tools use `inbox_`; CLI examples and closed input schemas are in the action catalogue.

## Threat model

- Prompt injection in customer messages: message text is untrusted evidence and cannot override the versioned system policy.
- Data exfiltration: selected evidence is tenant-owned; sender references are hashed; exports are private and redaction-aware.
- Unauthorized replies: owner/admin, `inbox:external`, dry-run/approval, idempotency, and executor receipt are all required.
- Race/lost update: assignment and resolution require expected version.
- Provider replay: inbound delivery and outbound request IDs must be provider-unique.

## Webhook and export contract

Hosting verifies provider signatures, resolves the workspace, and passes a delivery envelope to `message-ingest`. The core never accepts provider secrets. Exports pin the conversation and selected redaction policy.

## License and provenance

RelayDesk is new MIT code and documentation. No third-party help-desk source, UI, names, fixtures, or protected assets are included.
