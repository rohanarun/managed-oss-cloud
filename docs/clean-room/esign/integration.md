# E-signature central integration contract

The central source registry now includes the e-sign module and all 14 typed actions. The suite engine routes them through `executeEsignAction`; the AI worker verifies the host-owned result contract; storage accounting includes every immutable document object; migration `010-esign-atomicity-and-invariants` provides exact-once indexes plus atomic AI-audit completion; and migration `014-suite-storage-accounting` provides the immutable byte ledger and reconciliation boundary. The checklist below remains the review contract for future changes.

## Module and action registration

1. Keep `esign` registered as a Starter/shared module with the record types declared in the clean-room product specification.
2. Keep `esign: ["esign", "drive", "knowledge"]` in `aiReadScopes`. The engine accepts selected AI evidence only from those modules.
3. Preserve every item adapted from `esignActions` in `src/shared/suite-actions.ts` with `engine: "esign"`, including its JSON Schema, example, CLI/MCP metadata, scope, risk, idempotency, approval, and effect-boundary fields.
4. Continue routing `engine === "esign"` in `src/server/suite-engine.ts` to `executeEsignAction(store, auth, moduleId, actionId, input)`.
5. Keep `esignPromptPolicy`, `esignPromptDigest`, and `validateEsignAiCompletion` in the trusted AI worker. The worker must use the host-owned platform prompt, exact selected evidence, and the action's allowed proposal kinds. Successful completion must update `esign-ai-request-audit` atomically with the `suite_ai_actions` lease completion, equivalent to the existing core/premium/growth security-definer boundary.
6. Continue requiring `suite-storage-object.v1` on every `esign/document`, counting every retained document in `suite_storage_objects`, and reporting registered, verified, and unverified bytes separately. Updates cannot lower or overwrite size, hash, object reference/version, title, or immutable state. Object bytes still live in customer-selected storage, so production verification remains pending until the object-store adapter supplies an exact-version HEAD measurement to the controlled reconciliation function.
7. Keep `sessionToken` request fields and `privateOutput.signerSessionToken` redacted from HTTP, CLI, MCP, reverse-proxy, error, and telemetry logs. The signer token is intentionally returned once to the authorized caller and is never persisted in plaintext.

`esignIntegrationManifest()` exposes the module ID, action IDs, receipt type, audit type, and exact platform-prompt provenance for an integration assertion.

## PostgreSQL indexes

Migration `010-esign-atomicity-and-invariants` implements the equivalent indexes below under the existing owner/RLS model. Do not move these guarantees back into process-local prechecks.

```sql
CREATE UNIQUE INDEX esign_command_receipt_idempotency_idx
  ON suite_records(workspace_id,module_id,(data->>'idempotencyKey'))
  WHERE module_id='esign'
    AND record_type='esign-command-receipt'
    AND data ? 'idempotencyKey';

CREATE UNIQUE INDEX esign_signer_session_token_hash_idx
  ON suite_records((data->>'tokenHash'))
  WHERE module_id='esign'
    AND record_type='signer-session'
    AND data ? 'tokenHash';

CREATE UNIQUE INDEX esign_one_active_signer_session_idx
  ON suite_records(workspace_id,(data->>'envelopeId'),(data->>'signerId'))
  WHERE module_id='esign'
    AND record_type='signer-session'
    AND state='active';

CREATE UNIQUE INDEX esign_field_completion_once_idx
  ON suite_records(workspace_id,(data->>'envelopeId'),(data->>'fieldId'))
  WHERE module_id='esign'
    AND record_type='field-completion';

CREATE UNIQUE INDEX esign_template_version_once_idx
  ON suite_records(workspace_id,(data->>'templateId'),(data->>'templateVersion'))
  WHERE module_id='esign'
    AND record_type='template-version';

CREATE UNIQUE INDEX esign_document_object_version_once_idx
  ON suite_records(workspace_id,(data->>'objectRef'),(data->>'objectVersion'))
  WHERE module_id='esign'
    AND record_type='document';

CREATE UNIQUE INDEX esign_certificate_content_once_idx
  ON suite_records(workspace_id,(data->>'envelopeId'),(data->>'contentHash'))
  WHERE module_id='esign'
    AND record_type='certificate';
```

The existing `(workspace_id,module_id,record_type,updated_at DESC)` and GIN data indexes support tenant scans. The unique indexes above enforce the engine's exact-once invariants across processes; application prechecks alone are insufficient.

## Hosted signer endpoint

The CLI/MCP engine models the secure core but is not itself the public signer surface. `src/server/hosted-esign.ts` provides an explicit router/service contract, but the main application does not mount it automatically. A production mount must:

- accept the session token only in a protected channel and immediately hash it;
- apply rate limiting, CSRF/origin controls where applicable, cache prevention, strict transport security, and log redaction;
- load only the exact envelope/document/template hashes authorized by that session;
- verify object version and SHA-256 before rendering;
- present disclosure and capture explicit signer choices without model mediation; and
- call the same transactional engine boundary or a purpose-built public equivalent with identical state/version/hash rules.

Do not enable external delivery or market the workflow as production signing until that endpoint, exact-version sanitized object rendering, shared rate limiting, key management, retention, accessibility, privacy, abuse controls, and jurisdiction-specific legal review are complete. The implemented certificate records basic workflow facts only; identity assurance, qualified signatures, and legal compliance are explicitly not claimed.
