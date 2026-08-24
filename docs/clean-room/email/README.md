# Letterline clean-room record

Letterline is an original MIT-licensed, AI-native email newsletter workflow for the managed suite. The implementation was designed from public workflow requirements and email safety principles. It was not derived from, and does not claim API or UI compatibility with, Mailchimp, SendFox, listmonk, or another third-party codebase.

## Product boundary

Letterline provides strict CLI and MCP action contracts for purpose-bound audiences, normalized and deduplicated subscribers, immutable consent and suppression evidence, versioned campaign content, cited AI proposals, human review and approval, scheduling, provider-neutral dispatch plans, verified provider receipt ingestion, aggregate analytics, and private exports.

The engine deliberately does not:

- accept a purchased-list attestation;
- infer consent, sender identity, delivery, engagement, revenue, or attribution;
- store provider credentials;
- invoke an email provider;
- let a model add subscribers, change consent, approve, schedule, export, or dispatch;
- treat an AI proposal as reviewed campaign content;
- count an unverified webhook payload as provider evidence.

Every outbound-ready boundary is content-addressed. Every action that could release an approved plan or private export requires a dry-run path and attributable owner or administrator approval. Provider integration belongs in a separately reviewed adapter that consumes a dispatch plan and returns signed evidence through the verified receipt action.

## Action lifecycle

1. Create an audience with an explicit purpose and consent policy.
2. Record direct opt-in and an immutable consent receipt. Email normalization preserves plus addressing and does not silently merge different addresses beyond case and domain normalization.
3. Draft an immutable campaign version containing the exact sender identity, reply address, body, footer, and unsubscribe marker.
4. Record human review of claims, consent scope, sender identity, and unsubscribe behavior.
5. Bind owner or administrator approval to the exact content hash.
6. Schedule that approved version with a second explicit approval.
7. Build a provider-neutral dispatch plan after a fresh suppression check. This produces no network traffic.
8. Let a separate adapter perform any provider request. Ingest only gateway-verified provider evidence.
9. Immediately suppress hard bounces, complaints, and unsubscribes before later plans.

AI subject and body actions queue cited proposals under the immutable platform prompt. Their result contract stays pending human review and cannot mutate campaign or subscriber state.

## Integration

The implementation lives in:

- `src/shared/email-actions.ts`
- `src/server/email-engine.ts`
- `src/server/prompts/email.ts`
- `tests/email-engine.test.ts`

Central integration is present in this checkout: module ID `email` is a Starter/shared module, all 16 schemas feed the CLI and MCP generators, the suite engine routes to `executeEmailAction`, and the trusted AI worker validates the Letterline result contract. Migration `011-email-atomicity-and-invariants` adds exact-once indexes and atomic AI-action/audit completion. The action engine must continue to run inside one workspace transaction.

See `database-requirements.md` before enabling the module against PostgreSQL.
