# AI-native e-signature workflow product specification

## Product boundary

The module manages basic electronic workflow facts. It does not upload or render document bytes, contact signers, call a delivery provider, prove identity, create a person's signature, infer consent or intent, provide legal advice, or certify legal or regulatory compliance.

All business records live in the customer's existing `SuiteStore` workspace. PostgreSQL row-level security remains the final tenant boundary. Commands execute through `SuiteStore.runInWorkspaceTransaction`; commands store `esign-command-receipt` records so a retry returns the same durable result or rejects an idempotency-key collision.

## Fourteen actions

1. `template-create` creates a reusable private template container.
2. `template-version-create` freezes roles, route order, field geometry, disclosure text, and a canonical content hash.
3. `document-register` registers an opaque object reference and exact SHA-256/object version without fetching it.
4. `envelope-draft` binds one document hash and template version to privacy-minimized signer routes.
5. `envelope-preview` returns the exact dispatch preview hash without mutation.
6. `envelope-dispatch-plan` stores an approved plan only; `messageSent` and `providerCallStarted` remain false.
7. `signer-session-issue` returns a one-time private token and durably stores only its SHA-256.
8. `field-completion-record` records field value hashes and clocks, never raw values, identity proof, or a qualified-signature claim.
9. `decline-record` records an explicit decline under the exact signer-session boundary.
10. `envelope-void` terminalizes an incomplete envelope and revokes open sessions while preserving history.
11. `reminder-plan` stores a preview-bound approved reminder plan without sending it.
12. `certificate-export` stores a private, immutable canonical workflow manifest for a terminal envelope.
13. `clause-propose` queues cited, unreviewed clause proposals.
14. `field-routing-propose` queues cited, unreviewed field or route proposals.

Every action declares strict JSON Schema, CLI syntax, a unique MCP tool name, risk, required scope, idempotency, and effect boundary in `src/shared/esign-actions.ts`.

## Version and hash invariants

- Template versions are immutable and sequential under `expectedTemplateVersion`.
- Document registration binds `objectRef`, `objectVersion`, `sha256`, `sizeBytes`, `contentType`, and `pageCount`.
- Envelope drafts snapshot the template hash, document hash, signer routes, field geometry, expiry, and disclosure into `envelopeDraftHash`.
- State transitions use `expectedVersion`; signer actions also use `expectedSessionVersion`.
- Dispatch and reminder execution require the exact preview hash.
- A session is valid only for its envelope, signer, active state, and expiry. Earlier sequential routes must be complete before a later session is issued.
- Field completion requires every required field for one signer role, rejects duplicate field facts, and stores only `valueHash`.
- Certificates are canonical, content-addressed terminal-state manifests. Token hashes are deliberately omitted from the certificate.

## Human and AI boundaries

High-risk commands require `dryRun`. Applying them requires a reasoned approval whose `approvedBy` matches the authenticated owner or administrator. The module never delegates those approvals to a model.

AI requests bind the action, platform-prompt digest, target record snapshot hash, exact evidence record IDs and snapshot hashes, allowed proposal kinds, result contract, and model policy. Every proposal needs at least one authorized citation and remains `pending-human-review`. Model output cannot mutate templates, fields, routes, sessions, envelopes, or certificates.

## CLI and MCP

Central registration should adapt all fourteen action definitions directly. The definitions already provide examples such as:

```sh
supersuite action esign envelope-preview '{"envelopeId":"00000000-0000-4000-8000-000000000104","expectedVersion":1}'
```

MCP names use the stable `esign_<action_id>` form, for example `esign_envelope_preview` and `esign_clause_propose`. API-token scopes map to `esign:read`, `esign:write`, `esign:external`, or `esign:ai` at the engine boundary.
