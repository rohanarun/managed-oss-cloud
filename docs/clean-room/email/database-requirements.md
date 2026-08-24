# Letterline database and adapter requirements

These requirements are part of the email engine's safety contract. Migration `011-email-atomicity-and-invariants` implements the database indexes and atomic AI completion boundary in this checkout. A deployment is incomplete until that migration is applied under the separated roles and its own provider adapter tests pass.

## Tenant and role isolation

- Enable and force PostgreSQL row-level security for Letterline records and AI actions.
- Derive workspace identity from the authenticated transaction role or transaction-local setting. Never accept a workspace ID supplied by an untrusted record payload.
- Keep the control-plane role, runtime role, AI worker role, and migration role separate.
- Execute each action and its command receipt in one transaction. Use the existing workspace transaction lock or a transaction-scoped advisory lock so concurrent retries cannot both commit.

## Required indexes and constraints

The physical column names can follow the existing suite schema, but migrations must provide equivalent constraints:

```sql
CREATE UNIQUE INDEX suite_email_command_receipt_key
  ON suite_records (workspace_id, module_id, (data->>'actionId'), (data->>'idempotencyKey'))
  WHERE module_id = 'email' AND record_type = 'email-command-receipt';

CREATE UNIQUE INDEX suite_email_subscriber_hash_key
  ON suite_records (workspace_id, module_id, (data->>'emailHash'))
  WHERE module_id = 'email' AND record_type = 'subscriber';

CREATE UNIQUE INDEX suite_email_provider_event_key
  ON suite_records (workspace_id, module_id, (data->>'eventId'))
  WHERE module_id = 'email' AND record_type = 'provider-receipt';

CREATE UNIQUE INDEX suite_email_consent_receipt_hash_key
  ON suite_records (workspace_id, module_id, (data->>'receiptHash'))
  WHERE module_id = 'email' AND record_type = 'consent-receipt';
```

Before adding a unique index to an existing deployment, a migration must fail closed if duplicate keys exist. It must not choose a winner or delete evidence automatically.

## AI completion

The AI worker must verify the exact action ID, prompt ID, prompt version, prompt digest, requested model policy, executed model, target hash, evidence hashes, allowed proposal kinds, result-contract version, citations, confidence, review status, and approval flag. Completion of the AI action and update of the matching `email-ai-request-audit` record must be atomic. A malformed or mismatched completion must roll back and set no proposal as reviewed.

## Provider adapter

Provider credentials belong only in the deployment secret manager or a separately encrypted connection service. They must never appear in suite records, command receipts, logs, MCP results, AI context, or dispatch-plan payloads.

The Letterline engine only produces a dispatch plan. A separately reviewed adapter may hydrate normalized addresses by subscriber ID within the same tenant, enforce the plan and content hashes, run one final suppression check, call the configured provider, and submit a signed receipt to a verification gateway. The gateway must authenticate the provider payload before calling `provider-receipt-ingest` and must provide only a verifier identifier and payload hash, never a secret or raw signature key.

## Scale guidance

The current store interface scans tenant-scoped records. Before large-audience production use, route receipt, subscriber, suppression, campaign, and dispatch lookups through indexed repository methods while preserving the engine's transaction and idempotency semantics. Pagination and background export generation must not loosen tenant scope or place private export rows in command receipts.
