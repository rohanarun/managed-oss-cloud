# Managed OSS Cloud

Managed OSS Cloud is an MIT-licensed control plane and an original AI-native business suite. Customers get one account, one isolated workspace, one shared data graph, typed CLI and MCP access, custom domains, and transparent capacity upgrades. The repository supports both a managed-service deployment and a self-hosted Google Cloud path.

[Managed service](https://cloud.getsupers.com) · [Google Cloud guide](docs/google-cloud.md) · [Clean-room implementation record](docs/clean-room/README.md)

## Current status

The source registry in this checkout contains **37 first-party modules, 407 typed actions, and 447 MCP tools**. The MCP total is generated as three suite-level tools, one read-only list tool for each module, and one separately named tool for every typed action. Generic create/update/AI bypass tools are intentionally absent.

The hosted control plane is running the exact digest-pinned v0.4.0 release. Live checks on 2026-08-24 proved:

- `GET https://cloud.getsupers.com/api/health` reports PostgreSQL persistence with `mode: "dry-run"`;
- `GET https://cloud.getsupers.com/api/config` reports `billingReady: false` and the $7/$50/$200 plan catalogue;
- `GET https://cloud.getsupers.com/api/suite/catalog` returns all 37 first-party modules as JSON; and
- `GET https://cloud.getsupers.com/api/suite/actions` returns all 407 uniquely named typed actions.

The managed suite and account control plane are therefore live, but customer charging and one-click provisioning remain deliberately disabled. The hosted deployment preserves `PROVISIONING_MODE=dry-run`, `BILLING_MODE=disabled`, measurement-only storage accounting, and disabled subscription reconciliation. Those gates must not be presented as production-ready billing or provisioning until hard storage quotas, paid-capacity compensation, provider adapters, and the remaining live acceptance work pass.

## Implemented in source

- Public product site with an audited application catalogue.
- Signup, login, logout, salted `scrypt` password hashes, HTTP-only session cookies, rate limits, and same-origin mutation checks.
- PostgreSQL repositories for durable users, sessions, per-user server plans, domains, subscriptions, billing ledger entries, and idempotency records.
- Account-isolated dashboard for catalogue selection, server capacity, custom-domain CNAME instructions, and upgrade planning.
- Configurable machine prices and a separately itemized percentage/minimum management fee.
- Capacity checks that retain a memory safety reserve and split incompatible workloads.
- Terraform for an IAP-protected control plane and a horizontally scalable pool of private Google Compute Engine workers.
- Transactional Stripe checkout and signed, replay-safe webhook handling that queues provisioning only after payment.
- Authenticated remote Docker agents for install, start, stop, update, routing, encrypted backup, and restore jobs. Workers never receive PostgreSQL or Stripe credentials.
- Capacity-aware per-application placement, renewable job leases, and per-worker CPU, memory, and storage reservations.
- DNS verification, CNAME targets, a central dynamic Caddy gateway, private worker ingress, and automatic TLS after ownership resolves.
- Dry-run safety: checkout and provider mutations fail closed independently until their production gates pass.
- A first-party MIT suite with 37 modules, one shared PostgreSQL data plane, cross-module records and events, scoped API tokens, transaction-local workspace context, and forced row-level security for suite tables.
- Hosted accounts start with no module entitlement. A verified active or trialing Stripe subscription unlocks Starter, Scale, or Fleet modules; cancellation removes mutation and public-domain access immediately. Self-hosters can explicitly choose unrestricted suite mode.
- A provider-neutral AI action queue with a separate least-privilege worker. Model output is advisory and side effects always require a separate approved executor.
- An explicit, optional `local-ai` profile with a digest-pinned Ollama runtime, persistent Apache-2.0 Qwen3 4B weights, private-only networking, health-gated model initialization, and bounded default concurrency.
- A schema-aware `supersuite` CLI plus 447 MCP tools generated from the same 37-module/407-action registry.

The production data path uses PostgreSQL. Local development without `DATABASE_URL` deliberately uses temporary in-memory accounts and is not durability evidence.

## First-party MIT suite

These are clean, original implementations. Product names in the second column are category references only. The first-party modules do not claim API or UI compatibility and do not contain source code, branding, UI assets, or copy from those products.

Sixteen requested product distributions also have independent public MIT repositories. Each repository owns a product-specific web interface, scoped HTTP client, CLI, stdio MCP server, Dockerfile, tests, and a v0.1.0 release tag. They share tenant data only through this control plane's authenticated API; none contains database credentials or a competing migration owner.

| Product repository | Product repository | Product repository | Product repository |
| --- | --- | --- | --- |
| [PulseFlow](https://github.com/rohanarun/pulseflow) | [SignalDeck](https://github.com/rohanarun/signaldeck) | [RelayDesk](https://github.com/rohanarun/relaydesk) | [OrbitCRM](https://github.com/rohanarun/orbitcrm) |
| [Northstar Work](https://github.com/rohanarun/northstar-work) | [IdeaLoop](https://github.com/rohanarun/idealoop) | [AtlasBase](https://github.com/rohanarun/atlasbase) | [RouteKit](https://github.com/rohanarun/routekit) |
| [FairLaunch](https://github.com/rohanarun/fairlaunch) | [ProofPort](https://github.com/rohanarun/proofport) | [BeaconPage](https://github.com/rohanarun/beaconpage) | [Northstar Planning](https://github.com/rohanarun/northstar-planning) |
| [Harbor Vault](https://github.com/rohanarun/harbor-vault) | [Threadline](https://github.com/rohanarun/threadline) | [Ledgerline Operations](https://github.com/rohanarun/ledgerline-operations) | [Evident AI Workbench](https://github.com/rohanarun/evident-ai-workbench) |

| Family | Modules | Typed actions | Plan boundary |
| --- | ---: | ---: | --- |
| Core business rewrites | 8 | 72 | Starter |
| First-party growth | 3 | 36 | Starter |
| Specialist business operations | 9 | 120 | Starter |
| E-signature workflow | 1 | 14 | Starter |
| Letterline email marketing | 1 | 16 | Starter |
| Shared business graph | 5 | 46 | Starter or Scale |
| Governed operations | 5 | 61 | Scale or Fleet |
| Higher-resource modules | 5 | 42 | Scale or Fleet |
| **Total** | **37** | **407** |  |

| Module | Product category reference | Minimum plan | AI-native foundation |
| --- | --- | --- | --- |
| Automate | Activepieces | $7 Starter | Workflow drafting, run repair, explanations |
| Publish | Postiz | $7 Starter | Channel adaptation, campaign planning, performance summaries |
| Inbox | Chatwoot | $7 Starter | Triage, reply drafts, escalation detection |
| CRM | Frappe CRM | $7 Starter | Enrichment, relationship summaries, next actions |
| Tasks | Vikunja | $7 Starter | Goal decomposition, prioritization, progress updates |
| Feedback | Fider | $7 Starter | Deduplication, clustering, release notes |
| Knowledge | BookStack | $7 Starter | Cited answers, page drafting, stale-content detection |
| Links | Slash | $7 Starter | Link naming, destination checks, traffic summaries |
| Giveaways | KingSumo-style contests | $7 Starter | Contest drafting, fraud review, announcements |
| Testimonials | Review collection widgets | $7 Starter | Request drafting, highlights, sensitive-claim review |
| Brand Pages | QR and link-in-bio tools | $7 Starter | Page composition, variants, conversion summaries |
| Consent & Privacy | Public consent and GPC standards | $7 Starter | Evidence-backed classification and policy explanations |
| SEO Rank & Content | Public search measurement standards | $7 Starter | Cited briefs, exact-query clustering, change explanations |
| Freelancer Finance & Time | Public bookkeeping and time-tracking patterns | $7 Starter | Cited receipt/reconciliation proposals and unbilled-work summaries |
| Notifications | CloudEvents and public notification patterns | $7 Starter | Review-only workflow drafts and cited delivery explanations |
| Hiring | Public recruiting workflow standards | $7 Starter | Cited resume extraction and review-only candidate summaries |
| Collaborative Docs | Open document and canvas collaboration standards | $7 Starter | Exact-revision, approval-required structured patch proposals |
| Scheduling | Public scheduling and iCalendar standards | $7 Starter | Review-only availability, cited conflict explanations, routing suggestions |
| Forms | Public JSON Schema and accessibility standards | $7 Starter | Review-only form drafts, aggregate summaries, cited improvements |
| Feature Flags | OpenFeature and public experimentation standards | $7 Starter | Review-only rollout plans and evidence-linked evaluation explanations |
| E-Signature Workflow | Public electronic-signature workflow standards | $7 Starter | Cited clause/field proposals; no autonomous consent or compliance claim |
| Letterline | Public permission-based email marketing standards | $7 Starter | Cited subject/body proposals with human review and provider-neutral dispatch plans |
| SchemaDeck | Public relational-data and spreadsheet patterns | $7 Starter | Version-pinned schema proposals and deterministic formulas |
| Recall Room | Public meeting transcript and action-ledger patterns | $50 Scale | Transcript-cited proposals and human-owned decisions |
| Proofline Insights | Public business-intelligence and measurement patterns | $50 Scale | Measurement-clock provenance and fact/hypothesis separation |
| Learning Forge | Public learning-management and credential patterns | $50 Scale | Rubric-grounded proposals and human-issued credentials |
| Circlefield | Public forum and community-management patterns | $50 Scale | Policy-cited moderation proposals and reviewed announcements |
| GatherLedger | Public event, ticketing, and access-control patterns | $50 Scale | Receipt-bound inventory, money, access, and attendee proposals |
| PeopleWeave | Public HRIS and employment-record patterns | $50 Scale | Human employment decisions and cited development proposals |
| MeterProof | Public usage-metering and billing-ledger patterns | $200 Fleet | Deterministic charges and evidence-cited invoice explanations |
| AssureGraph | Public risk, control, and audit-evidence patterns | $200 Fleet | Human control outcomes and cited gap proposals |
| LiveForum | Public livestream, chat, and media-consent patterns | $200 Fleet | Consent-pinned broadcast state and unpublished replay proposals |
| Projects | Plane | $50 Scale | Issue writing, cycle planning, delivery risk |
| Drive | Nextcloud | $50 Scale | Classification, extraction, related-file discovery |
| Channels | Zulip | $50 Scale | Topic summaries, decisions, response drafts |
| Operations | ERPNext | $200 Fleet | Forecasting, reconciliation, margin explanations |
| Assistant | LibreChat | $200 Fleet | Workspace answers, approved tools, reusable agents |

All suite records carry a `workspace_id`. One PostgreSQL service may contain many customer workspaces, with transaction-local workspace context, forced row-level security, and separate runtime, AI, owner, and migrator roles. Inside a customer workspace, enabled modules intentionally share the record/link/event graph so contacts, files, evidence, and workflows can be connected without running 37 databases. This is logical tenant isolation in one data plane, not a dedicated database server per customer.

The separately installable upstream catalogue is a different boundary. Each upstream application retains its own database or volume layout and licence; installing one does not merge its private schema into the first-party suite database.

Every registered mutation uses a typed action rather than generic record creation. Domain engines add idempotency receipts, version/hash checks, evidence boundaries, dry runs, and explicit approvals where the operation is sensitive. That is a substantial application core, but it is not evidence that every module has passed every browser, realtime/offline, file, backup/restore, accessibility, provider, and jurisdiction-specific acceptance test. The clean-room documents remain the completion contract; no module is described as an indistinguishable commercial replacement.

### Public and external-effect boundaries

- **FairLaunch** exposes approved contests and consent-bound pseudonymous entries. Winner selection remains reproducible from a frozen candidate digest and recorded entropy inputs; it does not claim the caller-supplied public entropy source was independently authenticated.
- **ProofPort** exposes single-purpose collection URLs and version-pinned testimonial widgets. Capability tokens are stored as hashes, submissions remain private until separate moderation/publication, and current consent is rechecked on render.
- **BeaconPage** exposes approved page versions and stable QR routes. Stored destinations must be credential-free public HTTPS URLs. Short-link and QR redirects resolve the complete current A/AAAA set immediately before the 302 and reject non-global answers; page links use a DNS-checked, non-automatic external-navigation interstitial. The server never fetches destination content or follows redirect hops. DNS can still change between the check and a browser navigation, so the interstitial states that limitation and no stronger network-pinning claim is made.
- **Consent & Privacy** signs published policies and receipts with Ed25519. Verifiers must obtain an expected key set from `/.well-known/managed-oss-public-signing-keys.json` over the trusted HTTPS origin and pass that set explicitly; receipt data never supplies its own trust anchor. Retain prior public keys during signing-key rotation so historical receipts remain verifiable.
- **Letterline** creates consent-aware, provider-neutral dispatch plans. It does not send email, store provider credentials, or infer delivery. A separately reviewed adapter and verified receipt gateway are required for real delivery.
- **E-Signature Workflow** records content-addressed templates, envelopes, signer sessions, hash-only field facts, decisions, and basic workflow certificates. It does not assert identity assurance, qualified signatures, or legal compliance. The hosted signer router is not mounted automatically; production must explicitly supply an exact-version sanitized-PDF loader, exact allowed origin, shared atomic rate limiter, proxy/log redaction, retention policy, accessible signer UI, and legal review.

## CLI and MCP

Create an expiring API token from the AI Suite page, then configure the clients. The current dashboard shortcut creates a backward-compatible token with all three scopes; the token API also accepts a least-privilege scope list. `read` covers workspace/list/status operations, `write` covers enable/create/update and non-AI workflow actions, and `ai` covers AI requests and AI workflow actions.

```sh
export SUPERSUITE_URL=https://cloud.getsupers.com
export SUPERSUITE_TOKEN='copy-from-dashboard'

npm run cli -- modules
npm run cli -- actions crm
npm run cli -- actions hire
npm run cli -- action-help crm account-upsert
npm run cli -- enable crm
npm run cli -- action crm account-upsert '{"externalKey":"acct-42","name":"Northwind","domain":"northwind.example","idempotencyKey":"crm.account-upsert.sample-0001"}'
npm run cli -- action collab document-create '{"spaceId":"00000000-0000-4000-8000-000000000000","title":"Project brief","blocks":[]}'
npm run cli -- action email campaign-create '{"audienceId":"00000000-0000-4000-8000-000000000101","name":"September product letter","objective":"Explain reviewed product improvements to opted-in readers.","idempotencyKey":"email.campaign-create.sample-0001"}'
npm run cli -- action-help esign template-create
npm run mcp
```

`supersuite modules`, `supersuite actions [module]`, and `supersuite action-help <module> <action>` work offline. Action help prints required scope, fields, JSON Schema, example input, and MCP tool name. Action calls reject malformed JSON, missing fields, and invalid typed values before making a network request. There is no generic CLI create or AI command; every mutation and model request must use a registered action so tenant, version, evidence, idempotency, and approval invariants run through the shared engine.

The MCP server publishes 447 discoverable tools: `suite_catalog`, `suite_workspace`, and `suite_ai_status`; one namespaced list tool for each of 37 modules; and 407 separately named workflow tools. Each action tool exposes named typed parameters instead of an opaque action selector and advertises its required API-token scope in MCP metadata. Read-only tools accept least-privilege `read` tokens; mutation and AI tools require their separate scopes. Arbitrary SQL, shell commands, provider credentials, unrestricted paths, and generic record mutation are outside the MCP contract.

## AI runtime

The AI worker speaks the OpenAI-compatible chat-completions protocol, so it can use an approved hosted endpoint or the fully self-hosted Ollama profile without coupling product data to one model vendor.

```text
AI_MODE=openai-compatible
AI_BASE_URL=http://model-host:11434/v1
AI_MODEL=qwen3:4b
AI_API_KEY=
```

Start a hosted/separately managed endpoint worker with `docker compose --profile ai up -d ai-worker`. Start the private local runtime only when explicitly requested with `docker compose --profile local-ai up -d`; this initializes the pinned `qwen3:4b` model before its dedicated worker starts. Never run both worker profiles together.

The local profile downloads several gigabytes on first initialization and is not appropriate for a micro VM. See [Optional local AI runtime](docs/local-ai.md) for the verified image/model digests, Apache-2.0 model license, persistent storage path, health checks, no-public-port boundary, resource guidance, and operations commands. Requested goals and workspace records are treated as untrusted model input. Results are stored as proposals with evidence and approval requirements; the worker never executes external side effects.

## Upstream application catalogue

The catalogue below is separate from the first-party MIT suite. `ready` means a pinned deployment manifest is present in `catalog/apps.json`; it does not mean the current hosted preview can provision it while provisioning and billing are locked.

| Product category | Upstream project | Pinned version | Licence | Status |
| --- | --- | --- | --- | --- |
| Calendly-style scheduling | [Cal DIY](https://github.com/calcom/cal.diy) | v6.2.0 | AGPL-3.0 | Manifest `ready`; customer SMTP/calendar OAuth still required |
| Mailchimp-style newsletters | [listmonk](https://github.com/knadh/listmonk) | v6.2.0 | AGPL-3.0 | Manifest `ready`; customer provider/domain configuration still required |
| DocuSign-style signatures | [Documenso](https://github.com/documenso/documenso) | v2.17.0 | AGPL-3.0 | Manifest `ready`; customer SMTP and operational/legal review still required |
| Jotform-style forms | [HeyForm](https://github.com/heyform/heyform) | v3.0.1 | AGPL-3.0-only | Manifest `ready`; managed MongoDB, KeyDB, uploads, and hosting-layer Google OAuth broker |
| Uptime monitoring | [Uptime Kuma](https://github.com/louislam/uptime-kuma) | 2.3.2 | MIT | Manifest `ready` |
| Web analytics | [Umami](https://github.com/umami-software/umami) | v3.3.1 | MIT | Manifest `ready` |

The upstream catalogue remains available for customers who deliberately choose those packages. Managed OSS Cloud does not impersonate commercial products, and every upstream application retains its own licence, trademarks, and update policy. The first-party suite above is separate, original MIT-licensed code.

## Local development

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. Without `DATABASE_URL`, the app clearly reports `preview-memory` persistence.

## Production environment

```text
DATABASE_URL=postgresql://...
DATABASE_SSL=true
DATABASE_MIGRATION_MODE=manual      # production: run the one-shot migrate command before starting services
PUBLIC_APP_URL=https://control.example.com
PUBLIC_HOST_TARGET=apps.example.com
PROVISIONING_MODE=dry-run
PLAN_CATALOG_JSON={...}
PLATFORM_FEE_PERCENT=12
PLATFORM_FEE_MIN_CENTS=200
STRIPE_PUBLISHABLE_KEY=          # browser-visible publishable key
STRIPE_SECRET_KEY=               # load from Secret Manager, never Git
STRIPE_WEBHOOK_SECRET=           # load from Secret Manager, never Git
BILLING_MODE=disabled            # switch independently after live webhook proof
SUBSCRIPTION_RECONCILIATION_MODE=disabled # use dry-run first; apply only after provider/DB review
SUBSCRIPTION_RECONCILIATION_INTERVAL_MILLISECONDS=900000
PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS=86400000 # retry exact paid placement for 24h, then require cancellation + refund
WORKER_BOOTSTRAP_TOKEN=          # Secret Manager value used only for agent enrolment
GATEWAY_RECONCILER_TOKEN=        # Secret Manager value used only for route discovery
SUITE_ENTITLEMENT_MODE=hosted    # hosted: Stripe-derived plan; unrestricted: self-hosted all-module access
HOSTING_ENTITLEMENT_MODE=hosted  # hosted: installs/routes require the same provider-backed entitlement
CONSENT_POLICY_SIGNING_PRIVATE_KEY= # base64 PKCS#8 Ed25519 key from Secret Manager
CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS_JSON=[] # retained public Ed25519 keys for historical receipt verification
EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET= # dedicated Secret Manager value used only by trusted source adapters
```

Machine prices are configuration, not application constants. Set them from the current provider quote for the selected project and region.

The hosted defaults expose three pooled-capacity plans. They are customer quotas backed by the private worker fleet, not dedicated VM promises:

| Plan | Monthly total | Suite modules unlocked | Memory quota | CPU quota | Storage quota | Service instances |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Starter | $7 | 23 | 1.5 GB | 0.5 vCPU | 10 GB | 2 |
| Scale | $50 | 32 | 6 GB | 2 vCPU | 100 GB | 12 |
| Fleet | $200 | 37 | 24 GB | 8 vCPU | 500 GB | 50 |

The configured totals break down as Starter $5 infrastructure + $2 platform fee, Scale $44.64 + $5.36, and Fleet $178.57 + $21.43. These are logical customer quotas across the private worker fleet, not dedicated VM promises. Suite-only customers reserve no per-customer application-container capacity. A user can clone the same verified upstream service multiple times; every clone receives a separate hostname, container project, volume reservation, and placement decision. Upgrades reconcile the existing Stripe subscription before the stored quota changes.

In `hosted` entitlement mode, a new account has plan `none`: it can inspect the catalogue and billing choices but cannot enable modules, mutate shared records, run AI work, publish public routes, add custom domains, or keep paid installation jobs running. Cancellation immediately suspends routes and paid mutations. Existing private records remain read-only so a former customer is not locked out of their data while the explicit export/retention path is completed. The control plane derives the highest active or trialing paid plan from the provider-backed subscription ledger on authenticated suite requests and signed webhook events. In `unrestricted` mode, intended for a customer operating their own deployment, the workspace defaults to Fleet access and no Stripe subscription is required.

### Stripe subscription reconciliation

Audit Stripe against the existing PostgreSQL subscription rows with a read-only dry run:

```bash
npm run reconcile:subscriptions
```

The command uses Stripe SDK auto-pagination with `status=all`, emits a secret-free JSON report, and performs no schema initialization or database mutation in its default mode. Review ownership mismatches and invalid pricing metadata before applying. To mark provider-missing rows inactive, import or update ownership-verified Stripe rows, and recompute existing suite workspace entitlements in one PostgreSQL transaction, rerun with the explicit mutation flag:

```bash
npm run reconcile:subscriptions -- --apply
```

For continuous hosted enforcement, run the separate reconciliation worker with `SUBSCRIPTION_RECONCILIATION_MODE=dry-run` first. After its reports match the expected provider state, change only that service to `apply`. It serializes runs, emits secret-free structured summaries, and fails closed unless PostgreSQL, live Stripe billing, and the explicit apply mode are all configured. The same worker retries signed paid checkouts that arrived after their capacity hold expired. Pending rows remain non-entitled; deadline expiry emits `paid_capacity_compensation_required`. In apply mode the Stripe adapter proves the exact Checkout invoice and captured payments, idempotently cancels the subscription, refunds only the unrefunded captured remainder, and records Stripe subscription, invoice, and refund IDs only after every refund succeeds. Pending refunds remain pending and failed managed refunds stop for operator review; the repository never treats a requested refund as a confirmed refund.

The checked-in Google Cloud production path is stricter: `billing_mode="live"` is rejected unless provisioning is live, at least one private worker exists, scheduled reconciliation is already in `apply` mode, and every worker has an operator-provisioned hard project-quota backend with a completed exact-limit proof. The default ext4 bind mounts use measurement-only accounting: the worker measures allocated bytes, stops an over-limit Compose project, removes it from routing, and writes a durable quarantine marker, but that scan cannot prevent a brief overrun. It is therefore deliberately ineligible for live billing. Complete the dry run and install a reviewed quota helper separately before planning the atomic production transition.

Production database containers use `DATABASE_MIGRATION_MODE=manual`. Release orchestration must run `npm run migrate` as a one-shot job before starting the new control plane; the migration ledger is checksum-protected and guarded by a PostgreSQL advisory lock. Never edit an already released migration file—add a new numbered migration instead.

## Validation

```sh
npm test
npm run typecheck
npm run build
npm run verify:mcp
npm run audit:licenses
deploy/google-cloud/backup/tests/verify-backup-contracts.sh
deploy/google-cloud/readiness/tests/verify-readiness-contracts.sh
deploy/google-cloud/provenance/tests/verify-provenance-contracts.sh
```

The tests cover price/capacity policy, secure account flows, cross-account isolation, domain changes, fail-closed billing, authenticated node enrolment, capacity-aware placement, tenant affinity, and private gateway routes.

## Scale model

The public `e2-medium` is the control plane, not the place customer tools run. It owns accounts, scheduling, billing state, PostgreSQL, and edge TLS. Customer containers and persistent volumes run on private workers with no public IP. A worker is added when its advertised reservations no longer fit another application. Individual applications keep worker affinity for lifecycle and restore operations, while larger customer workspaces may span several workers behind the same edge gateway.

Google sign-in for managed HeyForm is a hosting-layer capability, not customer setup. The control plane alone owns the Google client secret, signed one-time state, PKCE code exchange, route authorization, and short-lived Ed25519 identity assertions. Workers and tenant containers receive only the broker URL, a public verification key, and the tenant's own application ID. See [Hosting-layer Google OAuth](docs/google-cloud.md#hosting-layer-google-oauth).

`worker_count` is deliberately explicit in Terraform. The scheduler will refuse an install that does not fit, rather than overcommit a node. Authenticated drain/activity endpoints make an agent-only rollout observable and prevent new leases while preserving healthy routes. Automated VM creation, application-volume migration, and node removal remain locked until restore, quota, cost, and failed-payment reconciliation have production proofs.

## Remaining live-provisioning gates

The current release is a safe control-plane MVP, not a production hosting marketplace. Before `PROVISIONING_MODE=live`:

1. Publish and digest-pin every application image and its dependencies.
2. Pass install, health, upgrade, rollback, encrypted backup, and restore tests per application.
3. Complete destructive lifecycle and failed-payment/cancellation reconciliation tests.
4. Prove tenant isolation, worker drain/migration, resource limits, secret rotation, outbound-email abuse controls, and incident recovery.
5. Confirm the exact Google Cloud account, project, region, quota, and recurring price before creating customer resources.
6. Mount the hosted signer only with an exact-version sanitized-PDF object loader, a shared multi-instance limiter, an accessible explicit-decision UI, and jurisdiction-specific review.
7. Keep Letterline provider calls disabled until a tenant-bound adapter and authenticated receipt gateway pass suppression, replay, abuse, and delivery-evidence tests.
8. Provision a filesystem project-quota backend and reviewed helper on every worker, prove exact path and byte-limit enforcement, then set `worker_storage_quota_backend="operator-project-quota"` and acknowledge `worker_storage_quota_proof_completed=true`; measurement-only ext4 bind mounts cannot support live billing.

## License

Managed OSS Cloud is MIT licensed. Catalogue applications retain their own upstream licenses.
