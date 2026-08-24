# Freelancer finance and time module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `finance` |
| Working category | Time, expenses, invoices, and payment reconciliation |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for teams, high receipt volume, bank feeds, many currencies, or long document retention |
| License target | Original first-party source under MIT |
| Primary outcome | A freelancer or small service business can turn approved work and expenses into accurate invoices, track payment, and export an auditable financial packet. |

This module is operational bookkeeping software, not tax, accounting, or legal advice. It must preserve user-entered facts and expose assumptions rather than asserting jurisdictional compliance.

## Public behavioral research record

- [Kimai public repository and README](https://github.com/kimai/kimai) describes projects, timesheets, rates, reports, exports, invoicing, users, budgets, and permissions.
- [Kimai AGPL-3.0 license](https://github.com/kimai/kimai/blob/main/LICENSE) is the official upstream license record.
- [Invoice Ninja public repository and README](https://github.com/invoiceninja/invoiceninja) describes clients, quotes, projects, tasks, expenses, invoices, payments, hosted and self-hosted operation.
- [Invoice Ninja Elastic License](https://github.com/invoiceninja/invoiceninja/blob/v5-stable/LICENSE) is the official upstream license record and is not an MIT-compatible source input.
- [Midday public repository and README](https://github.com/midday-ai/midday) describes time tracking, invoicing, receipt/transaction matching, storage, exports, and a finance assistant.
- [Midday license and commercial-use notice](https://github.com/midday-ai/midday/blob/main/LICENSE) must be read together with its README, which states that commercial use or deployments requiring a setup fee need a commercial license.

The implementation team may use only this specification. It may not inspect or copy any referenced product's source, schema, invoice templates, calculations, API, UI, text, tests, sample data, or assets.

## Clean-room boundary

### Permitted inputs

- Customer-entered clients, projects, rates, time, expenses, tax settings, payment facts, and branding.
- Current public documentation for payment, banking, email, OCR, and storage providers selected by the customer.
- Published, jurisdiction-specific invoice requirements only after separate legal review and with source/version provenance.
- General accounting concepts such as double-entry references, currency minor units, immutable issued documents, and audit trails.

### Prohibited inputs

- Code or derivative behavior copied from AGPL, Elastic, non-commercial, or ambiguous upstream materials.
- Reference invoice designs, terminology sets, numbering defaults, email copy, icons, or dashboards.
- Unverified tax computation, tax filing, payroll, money transmission, or claims of accounting compliance.
- Silent modification of issued invoices, payment records, approved time, or source documents.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage business identity, members, numbering, currencies, retention, connectors, and exports. |
| Finance manager | Approve time/expenses, create and issue invoices, record payments, credit invoices, and reconcile. |
| Contributor | Track own time, upload own receipts, and submit work for approval. |
| Accountant | Read financial records, make adjustment proposals, and export without managing access. |
| Client contact | View and pay only explicitly shared quotes/invoices through scoped public links. |
| Automation worker | Generate drafts, send approved documents, import statements, and run reminders within leases. |

Issuing, voiding, crediting, marking paid, changing numbering/tax rules, connector management, and raw financial export are privileged mutations.

## Original data requirements

The implementation owns a PostgreSQL schema named `finance`. Money is stored as integer minor units plus ISO currency. Floating-point arithmetic is prohibited for persisted amounts.

### `business_profile`

- Legal/display name, address, contact data, tax identifiers supplied by the user, default currency, time zone, locale, payment instructions, and brand-asset references.
- Sensitive identifiers are field-encrypted where appropriate.

### `client`

- Name, billing contacts/addresses, currency, locale, payment terms, tax treatment selected by the user, external references, and lifecycle state.
- Archiving a client does not delete issued documents.

### `project`

- Client, name, date range, members, billing method, budget, rate-card version, currency, status, and optional cross-module links.
- Billing methods: hourly, fixed, retainer, non-billable, or mixed line-item rules.

### `rate_card`

- Immutable versioned rates by project/member/activity, effective dates, currency, rounding rule, and approval actor.
- A time entry resolves to a specific rate-card version before invoice calculation.

### `time_entry`

- Contributor, project, activity, start/end or duration, local-date context, note, billable flag, source, state, and approval history.
- States: `draft`, `submitted`, `approved`, `rejected`, `locked`, `invoiced`, `written_off`.
- Overlap and impossible-duration validation is deterministic and configurable.

### `expense` and `receipt`

- Expense date, merchant/payee, category, subtotal/tax/total, currency, project/client, reimbursable/billable flags, payment method reference, state, and source document.
- Receipt stores object metadata, content hash, extraction result, confidence per field, and reviewer corrections.
- Original uploads are immutable; redacted derivatives are separate objects.

### `quote`

- Client, versioned lines, totals, terms, validity, state, acceptance evidence, and conversion link.
- States: `draft`, `sent`, `viewed`, `accepted`, `declined`, `expired`, `converted`, `withdrawn`.

### `invoice`

- Business/client snapshot, unique number, issue/due dates, currency, immutable line/tax/discount totals, terms, status, source record links, rendering hash, and issuance evidence.
- States: `draft`, `issued`, `partially_paid`, `paid`, `overdue`, `void`, `credited`, `written_off`.
- Issued invoices are immutable. Corrections use a credit note and replacement invoice where configured.

### `invoice_line`

- Description, quantity as fixed precision, unit, unit amount, discount, tax rule snapshot, subtotal, total, and source time/expense/project references.
- Line and invoice totals are independently recomputed and constrained.

### `payment`

- Client, invoice allocations, amount/currency, effective time, method, provider/external ID, state, evidence, and reversal link.
- States distinguish pending, succeeded, failed, reversed, refunded, and manually recorded.
- Provider webhooks use a unique provider event ID.

### `statement_import` and `transaction`

- Imported file/feed provenance, account alias, date range, source hash, transaction facts, and reconciliation state.
- Raw bank credentials are never stored in this schema.

### `reconciliation_match`

- Transaction, invoice/payment/expense target, suggested or confirmed state, score/rationale, actor, and time.
- AI suggestions do not alter payment status.

### `reminder_policy` and `delivery`

- Deterministic timing relative to issue/due dates, approved template version, recipients, send attempts, and provider receipts.

### `financial_export`

- Requested scope, schema version, generated object, content hash, actor, completion state, and expiration.

## Required workflows

### 1. Track and approve time

1. A contributor starts/stops a timer or enters a duration manually.
2. Deterministic validation checks boundaries, overlaps, required project/activity, and workspace policy.
3. Submission freezes the exact entry version for reviewer comparison.
4. A manager approves or rejects with a reason.
5. Approved entries resolve their rate and can enter one invoice draft exactly once unless released.

### 2. Capture and approve an expense

1. A contributor uploads a source document or enters an expense.
2. The object is virus-scanned and content-addressed.
3. OCR/AI proposes fields with per-field confidence and source coordinates where available.
4. A human confirms or corrects required fields before submission.
5. Approval determines reimbursement/billing eligibility; it does not create a payment.

### 3. Draft and issue an invoice

1. A finance manager selects a client/project, approved uninvoiced records, fixed items, dates, and terms.
2. The deterministic engine resolves rate versions, performs fixed-precision calculations, and shows a full source-to-line preview.
3. Validation rejects mixed unsupported currencies, duplicate sources, inconsistent totals, missing numbering authority, or invalid dates.
4. Issuance atomically allocates the next number, locks sources, freezes snapshots, renders a document, and records its hash.
5. Sending is separate: a failed email never reverses invoice issuance.

### 4. Correct, void, or credit

1. Drafts may be edited with optimistic concurrency.
2. Issued invoices cannot be edited in place.
3. An authorized actor records a void reason when legally/operationally allowed, or issues a linked credit note and optional replacement.
4. The original document remains available with its state and audit history.

### 5. Record and reconcile payment

1. A signed provider webhook or authorized manual action creates a payment fact.
2. Duplicate provider events are idempotent.
3. Allocations update invoice balance deterministically inside one transaction.
4. Statement imports may propose matches; only confirmation or trusted provider evidence changes reconciliation state.
5. Reversals append linked events and recompute balances without deleting the original payment.

### 6. Remind and report

1. Scheduler evaluates due/overdue state from stored dates and payment allocations.
2. Reminder policy creates a delivery only once per invoice/policy window.
3. AI may draft or adapt wording, but only approved template versions can be sent automatically.
4. Reports expose invoices, aging, approved/unbilled work, expenses, payments, and cash-flow projections with source clocks.

### 7. Export and delete

1. Authorized users request a versioned machine-readable export and rendered-document bundle.
2. The export reports included/excluded entities and hashes.
3. Retention deletion removes eligible drafts/source files while preserving issued-document and audit obligations configured by the customer.
4. Account deletion is blocked or staged when retention rules require preservation, with a clear explanation.

## AI contract

### Allowed AI actions

- Extract receipt fields with field-level confidence and evidence.
- Suggest categories, project/client matches, and transaction reconciliation candidates.
- Draft invoice descriptions, reminder text, cash-flow summaries, and anomaly explanations.
- Summarize unbilled work and highlight missing timesheets.
- Answer financial questions from cited workspace records.

### Forbidden AI actions

- Calculate authoritative invoice totals, tax, currency conversion, balances, or numbering.
- Issue, void, credit, mark paid, reconcile, delete, or send without the required deterministic workflow and authorization.
- Infer payment success from email, an uploaded screenshot, or conversational text.
- Give tax/legal advice as fact or invent jurisdictional rules.
- Send bank credentials, full tax IDs, payment tokens, or unredacted source documents to a remote model.

The deterministic finance engine owns all money arithmetic and state transitions. AI output never becomes a ledger fact merely because it is high confidence.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite finance client create --name "Example Client" --currency USD
supersuite finance timer start --project PROJECT_ID --activity consulting
supersuite finance time submit --entry ENTRY_ID
supersuite finance receipt upload --project PROJECT_ID --file receipt.pdf
supersuite finance invoice preview --project PROJECT_ID --through 2026-08-31
supersuite finance invoice issue --draft INVOICE_ID --confirm-version VERSION
supersuite finance payment record --invoice INVOICE_ID --amount-minor 250000 --currency USD
supersuite finance export create --year 2026 --format json
```

Required MCP tools:

- `finance_client_list`
- `finance_project_list`
- `finance_time_create`
- `finance_time_submit`
- `finance_receipt_extract`
- `finance_invoice_preview`
- `finance_invoice_issue`
- `finance_payment_record`
- `finance_reconciliation_suggest`
- `finance_reconciliation_confirm`
- `finance_report_query`
- `finance_export_create`

Issuance, payment recording, reconciliation confirmation, crediting, and voiding require mutation scopes and exact version confirmation. An MCP response never includes secret connector values.

## Resource and plan contract

- Starter supports individual and small-team time, expenses, invoices, reminders, and exports within pooled quotas.
- Scale is recommended for many users, high receipt/document volume, bank feeds, frequent OCR, or long retention.
- Payment processing, email, bank-feed, foreign-exchange, OCR/model, tax service, and object-storage usage is disclosed separately.
- Provider failure or exhausted quota leaves a durable actionable state; financial records do not disappear or falsely advance.

## Security and integrity requirements

- Money uses integer minor units or explicit fixed precision; no binary floating point enters persisted calculations.
- Issued document numbering uses a transactionally locked sequence scoped by business profile and configured period.
- Public invoice links are revocable, high-entropy, expiration-capable, and limited to one document/client context.
- Payment webhooks require provider signature verification and replay protection.
- Source documents are virus-scanned, content-addressed, private by default, and delivered with short-lived authorization.
- Sensitive identifiers and connector references are encrypted and redacted from logs/model context.
- Every invoice state and balance is rebuildable from immutable source facts and events.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| FIN-001 | Two workspaces create clients and invoices with the same names/numbers; no web, API, CLI, MCP, export, public token, worker, or search path crosses workspace boundaries. |
| FIN-002 | Two concurrent issue requests for separate drafts allocate different sequential invoice numbers with no gap caused by a failed transaction. |
| FIN-003 | Replaying issuance with the same idempotency key returns the original invoice; changing the draft version with that key fails. |
| FIN-004 | An issued invoice rejects in-place edits to client snapshot, lines, currency, totals, issue date, and number. A credit/replacement preserves the original. |
| FIN-005 | Invoice totals recomputed from stored fixed-precision lines equal the persisted totals across rounding-boundary fixtures and supported currencies. |
| FIN-006 | One approved time entry cannot be included in two active issued invoices; a failed draft or authorized release follows the documented state transition. |
| FIN-007 | Receipt extraction with uncertain tax and total values leaves those fields unconfirmed; no expense is approved solely from model confidence. |
| FIN-008 | A duplicated signed payment webhook creates one payment/allocation and returns an idempotent replay result. |
| FIN-009 | A payment reversal appends a linked reversal, restores the correct invoice balance, and preserves original provider evidence. |
| FIN-010 | A statement match suggested by AI does not mark an invoice paid or reconciled until an authorized confirmation or trusted signed provider event. |
| FIN-011 | Reminder evaluation run twice in the same policy window produces one delivery; an email failure leaves the invoice issued and records a retryable delivery state. |
| FIN-012 | A backup taken after invoice issuance restores invoice JSON and rendered-document hashes, source locks, payment allocations, and audit events. |
| FIN-013 | The versioned export reconciles record counts/totals to the API report and documents every excluded state. |
| FIN-014 | CLI and MCP invoice previews return the same lines, totals, source identifiers, version, and validation errors. |
| FIN-015 | With AI disabled, time approval, manual expenses, invoice calculation/issuance, payment recording, reminders, reports, and exports remain functional. |
| FIN-016 | An unauthorized contributor cannot approve time, issue invoices, view another contributor's private receipt, record a payment, or export the ledger. |

## Implemented first slice

The shared suite currently registers this as a Starter/shared-resource module with generated CLI/MCP actions for clients, projects, time creation/submission/approval, invoice preview/issuance, manual payment facts, and cited reconciliation suggestions. The shared engine enforces whole-minute non-overlapping time, frozen content hashes, integer-minor-unit invoice arithmetic, source locking, exact-version issuance, workspace/year invoice sequences, idempotency, same-currency payment allocation, and allowlisted AI context.

This slice makes no payment, email, banking, OCR, tax, or storage provider call and stores no provider or bank secret. Invoice issuance stores a deterministic rendering hash, not a rendered legal document. Cross-process transactional numbering/source locks still require the database transaction and uniqueness constraints described in this specification; the current engine lock provides deterministic single-process behavior and does not claim distributed accounting finality.

## Explicitly deferred

- Tax filing, payroll, regulated accounting certification, money transmission, lending, or custody.
- Automatic bank credential collection without a reviewed aggregation provider.
- Full general ledger and statutory financial statements; ERP Operations covers broader accounting later.
- Automatic foreign-exchange speculation or retroactive rate rewriting.
- Unreviewed jurisdiction-specific invoice or retention claims.
