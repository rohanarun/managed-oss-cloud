# Premium business suite product specification

## Product thesis

The premium suite is not five unrelated applications deployed beside each other. It is one tenant-scoped business graph with five distinct original operating surfaces. A customer may use one PostgreSQL service, but every request enters through an authoritative tenant context and every record, idempotency key, and audit receipt remains tenant-bound.

The first-party differentiator is evidence-first operation: deterministic facts are computed locally, model work is queued only after review, and consequential effects require a preview or explicit approval.

## Plans and resource profiles

| Product | Module | Minimum plan | Baseline resources | Included storage profile |
| --- | --- | --- | --- | --- |
| Northstar Planning | `projects` | Scale, $50/month | 500m CPU, 768 MiB, 2 workers | 4 GB |
| Harbor Vault | `drive` | Scale, $50/month | 750m CPU, 1 GiB, 2 workers | 50 GB object-registration profile |
| Threadline | `channels` | Scale, $50/month | 600m CPU, 1 GiB, 4 workers | 8 GB |
| Ledgerline Operations | `operations` | Fleet, $200/month | 1 CPU, 2 GiB, 4 workers | 25 GB |
| Evident AI Workbench | `assistant` | Fleet, $200/month | 2 CPU, 4 GiB, 2 model workers | 30 GB |

The application server must derive the plan from a verified subscription. It must never accept a plan field from an API body, CLI input, or MCP arguments.

## Action surface

Every action exports a strict JSON input schema, risk, destructive flag, external-effect class, idempotency policy, approval policy, CLI example, and stable MCP name.

### Northstar Planning

| Action | MCP tool | Invariant |
| --- | --- | --- |
| Create project | `projects_project_create` | Stable project key is unique per tenant. |
| Create issue | `projects_issue_create` | Issue belongs to one tenant-owned project and has whole capacity points. |
| Link dependency | `projects_dependency_link` | Same project, optimistic lock, no self-edge, no cycle. |
| Transition issue | `projects_issue_transition` | Only explicit state-machine transitions; no AI terminal mutation. |
| Draft cycle | `projects_cycle_draft` | Exact issue/version/point snapshot fits capacity. |
| Commit cycle | `projects_cycle_commit` | Exact hash, unchanged evidence, explicit approval or dry run. |
| Propose plan | `projects_plan_propose` | Evidence-bound, proposal-only model request. |
| Explain health | `projects_health_explain` | Cited explanation; no status mutation. |

### Harbor Vault

| Action | MCP tool | Invariant |
| --- | --- | --- |
| Create vault | `drive_vault_create` | Private classification boundary. |
| Register file | `drive_file_register` | Approval or dry run; checksum and opaque object key only. |
| Add version | `drive_file_version_add` | Optimistic lock and immutable version record. |
| Preview share | `drive_share_preview` | Exact file version, checksum, permission, and expiry hash. |
| Create share | `drive_share_create` | Exact approved preview; token plaintext is never stored. |
| Set retention | `drive_retention_set` | Approval, version, retention date, and legal-hold receipt. |
| Delete file | `drive_file_delete` | Soft deletion blocked by retention or legal hold. |
| Understand document | `drive_document_understand` | Exact checksum evidence; object key and bytes excluded from model context. |

### Threadline

| Action | MCP tool | Invariant |
| --- | --- | --- |
| Create stream | `channels_stream_create` | Stable stream key and explicit purpose. |
| Create topic | `channels_topic_create` | Topic has one question, decision, or coordination intent. |
| Preview message | `channels_message_preview` | Exact body and topic version hash, no send. |
| Post message | `channels_message_post` | Exact preview plus approval or dry run. |
| Redact message | `channels_message_redact` | Body removed; hash and reason retained. |
| Resolve topic | `channels_topic_resolve` | Human-authored decision with optimistic locking. |
| Summarize topic | `channels_topic_summarize` | Selected messages from that topic only. |
| Draft digest | `channels_digest_draft` | Selected topics from that stream only; never auto-send. |

### Ledgerline Operations

| Action | MCP tool | Invariant |
| --- | --- | --- |
| Create party | `operations_party_create` | Explicit kind and ISO currency. |
| Create item | `operations_item_create` | Tenant-unique SKU and integer-minor-unit price. |
| Create order | `operations_order_create` | Exact item-price snapshot and safe integer total. |
| Draft invoice | `operations_invoice_draft` | Exact order snapshot and content hash. |
| Issue invoice | `operations_invoice_issue` | Exact approved hash; no external delivery. |
| Preview journal | `operations_journal_preview` | At least two lines and exact debit-credit balance. |
| Post journal | `operations_journal_post` | Exact approved preview becomes immutable. |
| Record payment | `operations_payment_record` | Open invoice, matching currency, amount not above balance. |
| Explain variance | `operations_variance_explain` | Cited, non-posting model request. |

### Evident AI Workbench

| Action | MCP tool | Invariant |
| --- | --- | --- |
| Create collection | `assistant_collection_create` | Explicit evidence purpose. |
| Attach source | `assistant_source_attach` | Tenant-owned source version, record-snapshot hash, content checksum, and no copied raw payload. |
| Create prompt version | `assistant_prompt_version_create` | Immutable system, input, and output contract hash. |
| Preview run | `assistant_run_preview` | Prompt, collection, attached evidence, model, and goal; no invocation. |
| Execute run | `assistant_run_execute` | Exact preview and approval; initial output is null. |
| Record result | `assistant_result_record` | Claim-level authorized citations, confidence, model, prompt, and review. |
| Draft agent | `assistant_agent_draft` | Known MCP allowlist, bounded steps, no automatic mutation. |
| Approve agent | `assistant_agent_approve` | Exact inert content hash and explicit approval. |
| Execute agent | `assistant_agent_execute` | Approved version may propose only allowlisted actions; separate approval remains mandatory. |

## AI audit contract

Every queued AI request carries:

- immutable prompt version or prompt content hash;
- exact model identifier, never a key or bearer token;
- tenant-owned evidence IDs;
- `confidence: null` before a result exists;
- `review: {status: "pending", required: true}`;
- `output: null` and `fabricatedOutputAllowed: false`;
- an explicit statement that automatic mutation is disabled.

A reviewed result must contain a whole-number confidence from 0 through 100 and one or more claims. Every claim cites at least one evidence ID from both the authorized run set and the selected result set. The reviewer identity must match the authenticated actor.

## Shared database contract

The process-local engine is an executable domain specification. Production uses the durable `executePremiumBusinessAction` SuiteStore adapter. The PostgreSQL SuiteStore and dispatcher must preserve these boundaries:

1. The authenticated workspace ID is set from the session or API-token principal, never input JSON.
2. Every premium row includes `workspace_id`, and every unique or idempotency constraint includes that key where tenant-local uniqueness is intended.
3. PostgreSQL row-level security is enabled and forced for runtime roles before hosted writes are enabled.
4. Model workers receive only the evidence projection authorized for one action, not broad database credentials.
5. Audit receipts are append-only and hash-addressed.
6. Object bytes remain in customer-scoped object storage; Harbor Vault records only size, type, checksum, key, and lifecycle metadata.

## Exact integration map

The isolated slice intentionally does not edit current dispatch or billing files. A separate integration change should:

1. Adapt `premiumBusinessModules` into the existing module registry for `projects`, `drive`, `channels`, `operations`, and `assistant`; replace the current generic two-action surfaces only after tests prove parity.
2. Merge `premiumBusinessActions` into the CLI and MCP discovery registry. Preserve the exported `mcpToolName` exactly and use each `inputSchema` directly.
3. Route those five module IDs from the existing suite dispatcher to `executePremiumBusinessAction` in `premium-business-store-engine.ts`, inside `SuiteStore.runInWorkspaceTransaction`. The process-local `PremiumBusinessEngine` is a reference harness, not the production persistence path.
4. Derive `PremiumEngineContext.tenantId`, `actorId`, and `plan` from the authenticated workspace and subscription. Do not deserialize them from tool input.
5. Add the partial uniqueness indexes specified in `premium-store-integration.md` under the repository's staged RLS rollout. Premium domain state, AI audits, and command receipts use tenant-scoped Suite records. Do not store `privateOutput` in audit rows.
6. Route `ai-request` records through the existing AI worker only after it accepts the prompt/model/evidence/review contract. Provider credentials stay in worker-side secret storage.
7. Add end-to-end CLI and MCP tests proving all exported names, schemas, scopes, and plan failures, followed by live dry-run tests before enabling external effects.
