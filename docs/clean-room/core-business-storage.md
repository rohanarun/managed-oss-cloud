# Core business storage and snapshot contract

The eight first-party modules share one logical database, but they never share an authorization context. `CoreBusinessStorageAdapter.transaction` is the persistence boundary. A hosted PostgreSQL adapter must begin a database transaction, set the exact workspace and actor context, provide a transaction-bound `SuiteStore`, and commit records, command receipts, AI audit state, and executor receipts atomically.

The direct `suiteStoreCoreBusinessStorage` adapter exists for tests and a single-process deployment. Its lock is not a substitute for a database uniqueness constraint. Before horizontal production use, PostgreSQL must uniquely bind `(workspace_id, module_id, idempotency_key)` to one request hash and enforce workspace row-level security for every record and AI action table.

## Snapshot format

`core-business-snapshot.v1` includes:

- exact workspace ID and export clock;
- the 72-action catalogue with an input-schema digest and AI prompt versions;
- all eight modules' business records, command receipts, AI request audits, dry-run previews, and external-effect receipts;
- every AI action referenced by a command receipt, including queued/running/completed/failed state;
- a canonical SHA-256 integrity hash over the complete payload.

Validation rejects unknown top-level fields, another workspace ID, unknown module/action IDs, missing AI state, orphan AI state, duplicate or malformed IDs, invalid clocks, dangerous object keys, non-JSON/non-finite values, more than 100,000 records/actions, payloads over 64 MiB, a different action catalogue, and a mismatched snapshot hash.

## Atomic import

`importCoreBusinessSnapshotWithStorage` never writes through ordinary record creation because that would regenerate IDs and break relationships. It first validates the complete snapshot, then requires an owner-authorized adapter session with `replaceSnapshot`. The PostgreSQL implementation must stage the validated snapshot, recheck every workspace ID and foreign-key relationship, replace that workspace only, and commit or roll back as one transaction. An adapter without atomic replacement fails closed.

Snapshot files are private backups and may contain customer content. They must be encrypted at rest, access logged, retention-bounded, and never exposed through a public module endpoint.
