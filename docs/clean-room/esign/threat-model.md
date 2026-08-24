# E-signature workflow threat model

## Protected assets

- private object references and exact document hashes;
- immutable template, envelope, field, and terminal-event history;
- pseudonymous signer keys;
- signer-session capability tokens;
- field value hashes and completion clocks;
- approval and idempotency receipts; and
- selected AI evidence plus prompt and model provenance.

## Trust boundaries and mitigations

### Cross-tenant record references

Every record lookup goes through the authenticated user's `SuiteStore` context and checks `moduleId` plus expected `recordType`. The engine confirms the transaction workspace, current membership role, enabled module, paid plan, and exact scope before dereferencing action records. PostgreSQL RLS remains mandatory defense in depth.

### Duplicate, concurrent, or equivocated commands

The engine hashes the workspace, module, action, and canonical input, then persists a tenant-owned receipt in the same workspace transaction. A replay with the same key and hash returns durable result IDs. Reusing the key with different input fails. A database unique index is required so separate processes cannot both commit the same receipt.

### Capability-token disclosure

The engine generates a random token only after approval and returns it in `privateOutput` once. Durable session records contain only SHA-256. Receipts contain result IDs and a request hash; plaintext tokens and private output are excluded. A replay never reconstructs or returns the token. Logs, telemetry, reverse proxies, CLI history, and MCP clients must also redact the `sessionToken` input and `privateOutput` response.

### Document substitution and stale state

The envelope stores exact document and template hashes. Previews hash the current envelope version and immutable snapshots. Dispatch, field completion, decline, void, reminder, and export actions require optimistic versions. Object storage retrieval must independently verify the registered object version and SHA-256 before presentation.

### Unauthorized signing or consent

No engine action creates a signature, asserts identity, infers intent, or grants consent. `field-completion-record` stores a hash and clock under a signer-session boundary and labels identity assurance as `not-assessed`. External authentication, disclosure presentation, intent capture, jurisdiction-specific requirements, and actual document rendering are separate integration responsibilities.

### Prompt injection and fabricated legal claims

Workspace records and instructions are untrusted evidence. The immutable platform prompt requires cited proposals, prohibits legal advice and autonomous workflow changes, and keeps results pending human review. The host validates exact keys, proposal kinds, citations, confidence, assumptions, review status, and model identifier before recording completion provenance.

### Provider and delivery fabrication

Dispatch and reminder actions create plans only. Their records and audit results explicitly preserve `messageSent=false`, `providerCallStarted=false`, and `externalEffectExecuted=false`. A future executor needs its own connector receipt, retry policy, approval boundary, and provider evidence; it must never reinterpret a plan as delivery.

### Certificate overclaim

The export is named a workflow certificate only in the sense of a content-addressed audit manifest. It states `legalScope=basic-electronic-workflow-facts-only`, `qualifiedSignatureClaimed=false`, `complianceCertified=false`, and `identityAssuranceClaimed=false`. Customer-facing UI and marketing must preserve those limitations.
