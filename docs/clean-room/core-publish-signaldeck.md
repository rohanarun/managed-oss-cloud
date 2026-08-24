# SignalDeck clean-room product specification

## Product boundary

SignalDeck is a first-party MIT social campaign and publishing ledger. It was specified from user jobs: brief, approve, schedule, dispatch, observe, and learn. It does not copy a third-party scheduler's code, API, screen arrangement, data model, or branding.

## Why it is better and AI-native

- Campaign goal, audience consent, channels, and measurement plan exist before copy.
- Scheduled posts bind exact approved campaign and content hashes.
- Provider dispatch is a separate approved executor operation with a durable acceptance receipt.
- Metric observations retain their source and observation clock, preventing accidental causal claims from unequal exposure.
- AI variants and performance explanations cite selected records and expose confidence, assumptions, prompt provenance, model policy, and pending-human-review status.

## Domain model and invariants

`campaign` contains an immutable brief snapshot and approval hash. `scheduled-post` pins channel, content, campaign hash, and UTC time. `publication-delivery` represents approved pending work; only `external-effect-receipt` proves provider acceptance. `metric-observation` is append-only and provider-attributed.

Content cannot be scheduled from a stale campaign hash. Past timestamps are rejected. Imported metrics must be nonnegative finite observations. “Queued” and “accepted by provider” are never conflated.

## CLI and MCP surface

Actions: `channel-binding-preview`, `campaign-draft`, `content-variants-propose`, `campaign-approve`, `post-schedule`, `publication-dispatch`, `metrics-import`, `performance-explain`, and `campaign-export`. MCP tools use the `publish_` prefix. JSON Schemas include approval/dry-run controls for dispatch.

## Threat model

- Account takeover and token leakage: channel preview stores only a hashed account reference and capabilities; OAuth tokens remain at the hosting/executor layer.
- Accidental or malicious posting: only owners/admins with `publish:external`, exact approval, and a new idempotency key can dispatch.
- Prompt-generated misinformation: proposals cite immutable workspace evidence and cannot publish.
- Replay/double post: command receipts bind key to request hash; the provider adapter must additionally enforce its external request ID.
- Tenant leakage: all campaign, post, evidence, and receipt IDs are workspace-owned; production persistence must enforce RLS.

## Import and export

Metric imports require source and observation time. Campaign export includes brief, approvals, exact copy, delivery receipts, and clocks. Provider-specific adapters are replaceable and outside the clean-room core.

## License and provenance

SignalDeck code/specification is MIT. No third-party product code, content, logos, screenshots, or private API behavior was used.
