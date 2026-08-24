# Premium business suite clean-room record

## Scope

This record covers five first-party products implemented in `premium-business-actions.ts` and `premium-business-engine.ts`:

- Northstar Planning: outcome planning, issue dependencies, capacity snapshots, and cited plan proposals.
- Harbor Vault: private file metadata, immutable versions, pinned shares, retention, and cited document analysis.
- Threadline: stream and topic communication with exact message previews and evidence-linked summaries.
- Ledgerline Operations: parties, catalog facts, orders, invoices, payments, and balanced immutable journals.
- Evident AI Workbench: evidence collections, immutable prompts, grounded runs, reviewed results, and constrained agents.

These names, data contracts, state transitions, safety controls, action vocabulary, engine code, tests, and documentation are original to this repository. They are not ports, forks, themes, compatibility layers, or modified copies of Plane, Nextcloud, Zulip, ERPNext, LibreChat, or another product.

## Permitted category inputs

The design used only broad public product categories and user-requested outcomes: project planning, private files, topic-first chat, ERP/accounting, and an AI workbench. Category facts such as tasks having dependencies, accounting journals balancing, or messages belonging to topics are functional concepts and not copied expression.

The implementation did not use upstream source code, database schemas, route names, API payloads, screenshots, page layouts, documentation prose, icons, product names, or test fixtures. No upstream package is imported. Existing integrations should refer only to the original module names above.

## Independent design decisions

The suite deliberately differs from conventional category products:

- Every mutation is idempotent at the tenant, module, action, and key boundary.
- Every external message, file, accounting, model, or agent effect requires an exact human approval or a non-mutating dry run.
- Planning commits freeze capacity and issue versions before approval.
- File records use opaque object keys and checksums; model context excludes storage keys and object bytes.
- Messages require an exact preview hash before posting.
- Accounting uses integer minor units and deterministic double-entry validation.
- AI requests begin with `output: null`; they retain prompt version, exact model ID, evidence IDs, pending review, and a prohibition on fabricated output.
- Reviewed AI results require claim-level citations selected from the authorized run evidence.
- Agents are inert until their exact content hash is approved, and even then can only propose allowlisted actions that require their own authorization.

## Brand and compatibility policy

Do not advertise these products as clones, drop-in replacements, forks, or official integrations with the category references. Do not copy another product's UI, onboarding flow, command names, API routes, sample data, or branding in later work. A migration connector may be created only from a user-owned export or documented public interchange format, and must live outside the core product vocabulary.

## Review checklist

Before accepting a contribution, confirm:

1. The contributor did not consult or paste upstream implementation code into the change.
2. New product behavior is specified in first-party terms and tested from the product invariant.
3. Every new mutation has an idempotency contract.
4. Every external effect declares risk, destructive status, approval, and dry-run behavior.
5. AI output is empty until an authorized worker records a cited result with prompt, model, confidence, evidence, and review provenance.
6. Tests cover tenant isolation and at least one failure path, not only the successful path.
