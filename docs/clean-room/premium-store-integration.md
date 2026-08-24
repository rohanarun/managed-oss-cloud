# Premium SuiteStore integration contract

## Production entry point

The production-persistent adapter is exported from `src/server/premium-business-store-engine.ts`:

```ts
executePremiumBusinessAction(
  store: SuiteStore,
  auth: PremiumBusinessAuthorization,
  moduleId: PremiumModuleId,
  actionId: PremiumActionIdFor<typeof moduleId>,
  input: Record<string, unknown>,
  dependencies?: Partial<PremiumBusinessStoreDependencies>,
): Promise<PremiumBusinessStoreResult>
```

The adapter opens the authenticated workspace transaction itself. A dispatcher may also wrap it; nested SuiteStore transactions reuse the same workspace lock and database transaction:

```ts
store.runInWorkspaceTransaction(auth.userId, () =>
  executePremiumBusinessAction(store, auth, moduleId, actionId, input, dependencies),
);
```

`auth.workspaceId`, `auth.role`, and `auth.scopes` come from the authenticated session or API-token principal. They are never accepted inside action input. The adapter rechecks workspace, membership role, enabled module, plan, and action scope before any lookup or write.

The earlier `PremiumBusinessEngine` class remains a process-local executable domain reference for isolated unit tests. Production dispatch must use `executePremiumBusinessAction`; that function does not read or reconstruct the class's Maps.

## Retained object accounting

Drive file heads are mutable pointers and do not represent additional stored bytes. Every immutable `drive/file-version` carries `suite-storage-object.v1` metadata with its exact object key, file/version identity, checksum, registered byte count, size source, and object-store verification state. Each retained version consumes quota independently, including versions behind a soft-deleted file head. The store serializes create and update checks on the same workspace advisory lock.

Migration `014-suite-storage-accounting` copies legacy versions into `suite_storage_objects`, makes the registered identity and byte count immutable, prevents deleting retained metadata without a future audited release path, and provides a control-plane-only reconciliation function. Reconciliation can mark an exact object-store HEAD measurement verified or mismatched; it can never lower or replace the registered byte count. Until a real object-store adapter performs that HEAD request, the bytes remain explicitly `registered-unverified` and still consume quota.

## Durable records

The adapter writes ordinary tenant-scoped Suite records for all domain state. Every mutable domain record carries `data.version`, which is checked before optimistic transitions and incremented on update.

Every non-read command, including a dry-run command, writes one `premium-command-receipt` in the action module. The immutable receipt contains the action ID, idempotency key, canonical request hash, durable result IDs, optional AI action ID, audit payload, and receipt hash. It never contains private share-token plaintext. An identical retry resolves the receipt and returns the original result records; a changed request with the same action/key fails.

Every real model request writes a `premium-ai-request-audit` and a Suite AI action in the same workspace transaction. The audit begins with:

- exact prompt version and requested model ID;
- `executedModelId: null` and `confidence: null`;
- exact evidence IDs and record snapshot hashes;
- `output: null`;
- pending-model review state;
- fabricated output and autonomous mutation disabled.

After a worker completes a Suite AI action, call `recordPremiumBusinessAiCompletion` inside a workspace transaction. It verifies the exact prompt, model, evidence set, claim citations, confidence, and pending-human-review contract before binding the result hash to the audit. `assistant.result-record` then requires an exact match to that completed model result plus attributable human review.

The AI worker must detect `context.resultContract.version === "premium-business-ai-result.v1"`, verify the ID, version, and digest against `prompts/premium-business.ts`, use that module's platform system policy, constrain the model to the premium result contract, attach the actual executed model ID, and call `validatePremiumBusinessAiCompletion` before marking the Suite AI action completed. The legacy generic `{proposal, evidence, assumptions}` result shape is intentionally incompatible and must not be treated as a premium completion.

## Required uniqueness index

The workspace transaction advisory lock serializes commands, while this partial unique index is the database backstop for retry safety across processes and future dispatch paths:

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  suite_records_premium_receipt_idempotency_unique
ON suite_records (
  workspace_id,
  module_id,
  (data->>'actionId'),
  (data->>'idempotencyKey')
)
WHERE record_type = 'premium-command-receipt';
```

The production migration should create the equivalent index without `CONCURRENTLY` when it runs inside a transaction. Existing duplicate rows must be audited before index creation; do not silently delete receipts.

## Recommended invariant indexes

The adapter checks these invariants under the workspace transaction lock. Database indexes should additionally enforce them:

```sql
CREATE UNIQUE INDEX suite_records_premium_project_key_unique
ON suite_records (workspace_id, (data->>'key'))
WHERE module_id = 'projects' AND record_type = 'project';

CREATE UNIQUE INDEX suite_records_premium_stream_key_unique
ON suite_records (workspace_id, (data->>'key'))
WHERE module_id = 'channels' AND record_type = 'stream';

CREATE UNIQUE INDEX suite_records_premium_item_sku_unique
ON suite_records (workspace_id, (data->>'sku'))
WHERE module_id = 'operations' AND record_type = 'item';

CREATE UNIQUE INDEX suite_records_premium_ai_action_audit_unique
ON suite_records (workspace_id, (data->>'aiActionId'))
WHERE record_type = 'premium-ai-request-audit'
  AND data ? 'aiActionId';

CREATE UNIQUE INDEX suite_records_premium_source_pin_unique
ON suite_records (
  workspace_id,
  (data->>'collectionId'),
  (data->>'recordId'),
  (data->>'sourceVersion'),
  (data->>'sourceSnapshotHash'),
  (data->>'contentHash')
)
WHERE module_id = 'assistant' AND record_type = 'source-attachment';
```

All indexes remain tenant-prefixed. They complement, rather than replace, forced row-level security for runtime roles.

## Dispatcher result mapping

`PremiumBusinessStoreResult` already uses the shared dispatcher shapes:

- `kind: "read"` for non-mutating previews;
- `kind: "command"` for domain writes and dry-run commands;
- `kind: "ai-action"` with the durable Suite AI action for queued model work.

The root dispatcher should preserve the returned action metadata, records, audit, preview, and AI action. `privateOutput` is one-time sensitive output and must be returned only on the authenticated response; it must not enter events, receipts, logs, analytics, or replay payloads.
