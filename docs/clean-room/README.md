# Clean-room first-party suite

This directory records the product and security contracts for 27 original, first-party modules released under this repository's MIT license. They capture user-visible business behavior without importing reference-product source code, schemas, tests, interface copy, visual assets, trademarks, or internal architecture.

The source registry currently contains 300 typed actions. The count below is derived from `suiteModules` and `suiteActions`, not from documentation estimates. Reference products identify only a broad business category; the first-party modules do not claim API, data-model, or UI compatibility.

## Module index

| Family | Module ID | Clean-room record | Actions | Minimum hosted plan |
| --- | --- | --- | ---: | --- |
| Core | `automate` | [Automate](core-automate-pulseflow.md) | 9 | Starter, $7/month |
| Core | `publish` | [Publish](core-publish-signaldeck.md) | 9 | Starter, $7/month |
| Core | `inbox` | [Inbox](core-inbox-relaydesk.md) | 9 | Starter, $7/month |
| Core | `crm` | [CRM](core-crm-orbitcrm.md) | 9 | Starter, $7/month |
| Core | `tasks` | [Tasks](core-tasks-northstar-work.md) | 9 | Starter, $7/month |
| Core | `feedback` | [Feedback](core-feedback-idealoop.md) | 9 | Starter, $7/month |
| Core | `knowledge` | [Knowledge](core-knowledge-atlasbase.md) | 9 | Starter, $7/month |
| Core | `links` | [Links](core-links-routekit.md) | 9 | Starter, $7/month |
| Growth | `giveaways` | [FairLaunch](first-party-growth/product-spec.md) | 12 | Starter, $7/month |
| Growth | `testimonials` | [ProofPort](first-party-growth/product-spec.md) | 12 | Starter, $7/month |
| Growth | `brand-pages` | [BeaconPage](first-party-growth/product-spec.md) | 12 | Starter, $7/month |
| Specialist | `consent` | [Consent and privacy](consent-privacy.md) | 9 | Starter, $7/month |
| Specialist | `seo` | [SEO rank and content](seo-rank-content.md) | 10 | Starter, $7/month |
| Specialist | `finance` | [Freelancer finance and time](freelancer-finance-time.md) | 9 | Starter, $7/month |
| Specialist | `notify` | [Notifications](notifications.md) | 10 | Starter, $7/month |
| Specialist | `hire` | [Applicant tracking](applicant-tracking.md) | 17 | Starter, $7/month |
| Specialist | `collab` | [Collaborative documents and whiteboards](collaborative-docs-whiteboards.md) | 16 | Starter, $7/month |
| Specialist | `schedule` | [Scheduling and booking](scheduling-booking.md) | 16 | Starter, $7/month |
| Specialist | `forms` | [Forms and data collection](forms-data-collection.md) | 16 | Starter, $7/month |
| Specialist | `flags` | [Feature flags and experiments](feature-flags-experiments.md) | 17 | Starter, $7/month |
| Agreement | `esign` | [E-signature workflow](esign/product-spec.md) | 14 | Starter, $7/month |
| Email | `email` | [Letterline](email/README.md) | 16 | Starter, $7/month |
| Higher resource | `projects` | [Premium suite](premium-product-spec.md) | 8 | Scale, $50/month |
| Higher resource | `drive` | [Premium suite](premium-product-spec.md) | 8 | Scale, $50/month |
| Higher resource | `channels` | [Premium suite](premium-product-spec.md) | 8 | Scale, $50/month |
| Higher resource | `operations` | [Premium suite](premium-product-spec.md) | 9 | Fleet, $200/month |
| Higher resource | `assistant` | [Premium suite](premium-product-spec.md) | 9 | Fleet, $200/month |
|  | **Total** |  | **300** |  |

Hosted plan gates are explicit in the source registry: Starter unlocks 22 modules, Scale unlocks those plus Projects, Drive, and Channels, and Fleet unlocks all 27. A self-hosted operator may select `SUITE_ENTITLEMENT_MODE=unrestricted` to expose all modules without Stripe. Plan labels still express the hosted capacity and support boundary; they do not change the MIT licence.

## Shared product contract

### Customer and module isolation

- A workspace has a stable UUID, one owner, and explicit member roles.
- Every suite row carries `workspace_id`; authenticated entry points derive the workspace from membership or a scoped token rather than trusting a payload-supplied tenant ID.
- One PostgreSQL service and one suite table set may contain many customer workspaces. Migration 006 enables and forces row-level security on workspace, membership, module, record, event, AI-action, token, link, and suite-domain tables.
- Runtime, AI, suite-owner, and migrator roles are separate. Runtime and AI paths set transaction-local `app.workspace_id`; application filtering remains defense in depth.
- Enabled modules inside one workspace intentionally share records, links, events, and selected AI evidence. Cross-module reads are allowlisted per action.
- The installable upstream-app catalogue does not share this schema. Each upstream application retains its own database/volume design and licence boundary.

### Common record guarantees

Typed engines build domain guarantees on the shared `suite_records` and `suite_events` graph. Every durable business entity has or is required to have:

- an immutable identifier;
- `workspace_id`, creator, creation time, and last-modified time;
- an explicit lifecycle state rather than deletion-by-absence;
- optimistic concurrency metadata;
- an append-only receipt or audit trail for security-sensitive or externally visible mutations;
- a portable JSON export representation with a documented version;
- a retention and deletion class.

The shared graph is the current system of record. Domain engines must therefore supply typed validation, expected-version checks, content hashes, idempotency receipts, approval evidence, and database uniqueness constraints where application prechecks are insufficient. A future dedicated table may replace a record type only through a reversible migration and parity proof.

### API, CLI, and MCP guarantees

- The HTTP API is the single behavioral implementation. Web UI, CLI, and MCP invoke the same authorization and validation paths.
- The executable is `supersuite`. Registry inspection uses `modules`, `actions`, and `action-help`; remote behavior uses `workspace`, `enable`, `list`, `ai-status`, and `action <module> <action> <json-input>`.
- The MCP server exposes three suite-level tools, one namespaced list tool per module, and one namespaced typed tool per action: 330 tools in the current registry.
- Read and mutation scopes are separate. Destructive, financial, hiring-decision, policy-publishing, and public-share mutations require explicit mutation scopes and may require human confirmation.
- MCP tools never accept arbitrary SQL, shell commands, template code, provider credentials, or unrestricted file paths.
- Generic record creation and generic AI requests are not exposed by CLI or MCP. All mutations and model requests use a registered action and the same HTTP/engine validation path.
- A typed action returns its durable result identifiers and audit boundary; idempotent actions report replay state where their contract provides it.
- Secrets are created or rotated through dedicated secret inputs and are never returned after initial acceptance.

### AI guarantees

- AI is an optional assistant over deterministic business primitives. Non-AI actions work when no model is configured; external provider adapters remain separate where a module deliberately stops at a plan or manifest.
- Every AI action records model/provider, prompt-template version, input record identifiers, output, confidence where applicable, actor, timestamps, and acceptance/rejection outcome.
- AI output is a proposal until a documented workflow explicitly accepts it. It cannot silently publish policies, send campaigns, issue invoices, reject candidates, disclose private documents, or alter access control.
- Generated assertions must cite workspace records or clearly state that they are suggestions. A model must not fabricate measurements, legal compliance, payment status, ranking observations, delivery receipts, or candidate qualifications.
- Provider credentials and raw secrets are never added to model context. Sensitive fields use allowlisted projections, with redaction before remote inference.
- Deployments can select an OpenAI-compatible endpoint or the optional private Ollama/Qwen profile. Model access does not bypass module scopes, evidence allowlists, review status, or effect boundaries.

## Clean-room operating procedure

### Research role

The research role may inspect public marketing pages, public user documentation, public READMEs, published API descriptions, applicable standards, and the license text. It records only externally observable behavior and facts necessary to define a new product.

### Specification role

The specification role translates those observations into original domain language, entities, state machines, security invariants, and black-box acceptance tests. It must not reproduce upstream text, screenshots, test cases, endpoint names, database identifiers, or visual layouts.

### Implementation role

The implementation role works from these specifications and general-purpose framework documentation only. For the corresponding reference products, it must not inspect:

- source files, commit history, pull requests, issues containing patches, generated bundles, or container layers;
- schemas, migrations, internal APIs, test fixtures, snapshots, or algorithm descriptions tied to source;
- copyrighted copy, screenshots, illustrations, icons, themes, templates, or seed data;
- trademarked names in module names, domains, package names, screenshots, or user-facing compatibility claims.

If an implementer has previously contributed to or deeply inspected a reference implementation, that contributor records the exposure and is assigned to a different module or receives legal review before contributing.

### Verification role

The verification role runs the behavioral acceptance tests against only public interfaces. It may compare outcomes to this specification, not source-level structure. It also produces:

- dependency license inventory and SBOM;
- provenance attestations from contributors;
- secret and copied-string scans;
- trademark/name review;
- accessibility, isolation, authorization, backup/restore, export, and deletion evidence.

## Dependency policy

- First-party source is MIT.
- Dependencies must be independently reviewed. MIT, BSD, ISC, and Apache-2.0 dependencies may be usable, but their notices and terms remain in force; an Apache-derived file is not made MIT merely by placing it in an MIT repository.
- GPL, AGPL, LGPL, Elastic, Functional Source License, Sustainable Use License, Commons Clause, business-source, non-commercial, and ambiguous/custom-license code is not copied into these modules.
- Model weights, fonts, icons, templates, locale data, SDKs, and generated assets are part of the dependency review.
- No reference product name is used as a package name, executable, service name, database schema, or default tenant-facing label.

## Specification completion gate

A module is not considered implemented merely because it can create generic records. Completion requires every acceptance test in its specification to pass at the described interface and scope, plus:

1. workspace-isolation tests with two real workspaces;
2. permission tests for every CLI and MCP mutation;
3. restart and backup/restore durability evidence;
4. export and deletion evidence;
5. a dependency and provenance audit confirming the MIT clean-room boundary;
6. a live browser workflow for the primary user outcome;
7. CLI and MCP parity tests against the same durable records.
