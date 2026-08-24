# Consent and privacy module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `consent` |
| Working category | Consent and privacy operations |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale when scanning many domains or retaining high-volume consent receipts |
| License target | Original first-party source under MIT |
| Primary outcome | A site owner can discover data-collecting resources, publish a versioned consent policy, block governed resources until an allowed decision, and prove what a visitor chose. |

This module is an operational consent tool, not legal advice or an automatic guarantee of GDPR, ePrivacy, CCPA, or other regulatory compliance. It must expose factual configuration and evidence without claiming that a policy is legally sufficient.

## Public behavioral research record

Research sources establish public behavior only. They are not implementation dependencies.

- [Klaro public repository and README](https://github.com/KIProtect/klaro) describes a configurable consent widget, purposes, third-party-resource blocking, translations, and a JavaScript control surface.
- [Klaro BSD-3-Clause license](https://github.com/KIProtect/klaro/blob/master/LICENSE) is the official upstream license record.
- [Global Privacy Control specification](https://privacycg.github.io/gpc-spec/) defines the public `Sec-GPC` signal and related browser behavior.
- [Google consent mode documentation](https://developers.google.com/tag-platform/security/guides/consent) describes Google tag consent-state integration. Google-specific support is an adapter, not the core consent model.

Observed product concepts may be implemented independently. No Klaro source, configuration names, UI copy, styles, translations, examples, APIs, tests, or assets may be copied.

## Clean-room boundary

### Permitted inputs

- The behaviors and standards summarized in this specification.
- Browser platform documentation for DOM, CSP, cookies, storage, request interception, and HTTP headers.
- General-purpose permissive libraries that pass repository dependency review.
- A customer's own website, policy text, vendor list, and configuration.

### Prohibited inputs

- Upstream source, bundles, package internals, schemas, tests, example configuration, default service catalog, or translation files.
- Upstream banner layout, wording, icons, CSS, category names, API names, or configuration keys.
- Claims that a public reference project authorizes this product, or use of its trademark in the module name.
- Automatically generated legal conclusions presented as advice or compliance certification.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage domains, retention, members, provider credentials, policy publication, exports, and deletion. |
| Privacy editor | Review scan findings, manage services and purposes, draft policies, and view aggregate results. |
| Publisher | Publish or roll back a policy revision after reviewing its diff. |
| Analyst | Read aggregate choice and scan reports without visitor identifiers. |
| Runtime client | Retrieve a signed public policy and submit or revoke a visitor choice. |
| Auditor | Read immutable policy, receipt, publication, and deletion evidence. |

Publication, rollback, raw receipt export, and retention changes are privileged mutations. A public runtime token cannot read workspace administration data.

## Original data requirements

The implementation owns a PostgreSQL schema named `consent`. JSON may hold vendor-specific extension fields, but the following entities and relationships are typed.

### `site`

- Workspace-scoped name, canonical origin, verified domains, default locale, default region rule, and runtime public key.
- A domain must be proven by DNS or an HTTP challenge before a production runtime policy can be published for it.
- Domain ownership history is retained in the audit log.

### `scan_run`

- Site, requested URLs, crawl limits, initiating actor, state, start/end times, scanner version, and failure summary.
- States: `queued`, `running`, `review`, `completed`, `failed`, `canceled`.
- A completed run is immutable; a later run creates a diff.

### `resource_observation`

- Scan, page URL, normalized resource URL, resource kind, initiator, observed storage keys, response host, first/last observation, and evidence hash.
- Classification and purpose are separate reviewable fields; the raw observation is never overwritten by AI output.

### `service`

- Original workspace-defined label, responsible domain/operator supplied by the customer, description, purposes, resource match rules, retention note, privacy-policy URL, and status.
- States: `draft`, `active`, `retired`.
- Match rules are versioned and deterministic.

### `purpose`

- Workspace-authored label, explanation, required/optional flag, display order, and stable key.
- A purpose cannot silently become required in an already published revision.

### `region_rule`

- Ordered region or signal predicates and the policy behavior they select.
- Includes an explicit fallback when geolocation is unavailable.
- GPC handling is represented as a policy rule with recorded source, not hard-coded marketing language.

### `policy_revision`

- Site, monotonically increasing version, immutable purpose/service snapshot, locale copy, region rules, runtime behavior, CSP guidance, author, approval actor, and publication timestamps.
- States: `draft`, `approved`, `published`, `superseded`, `withdrawn`.
- Only one revision is active for a site and deployment channel at a time.
- Published revisions are content-addressed and signed.

### `consent_receipt`

- Pseudonymous visitor key, site, policy revision, decision per purpose/service, signal context, locale, creation time, optional expiration, revocation link, and integrity hash.
- The module does not require names, emails, raw IP addresses, or browser fingerprints.
- A new choice or revocation appends a receipt; it does not mutate the prior receipt.

### `runtime_event`

- Policy fetch, decision submission, revocation, invalid-signature, and configuration error events with coarse operational context.
- Runtime analytics must not become cross-site visitor tracking.

### `alert`

- New resource, changed vendor host, unclassified observation, broken policy fetch, or receipt-ingestion failure; includes state, assignee, and resolution evidence.

## Required workflows

### 1. Add and verify a site

1. An editor creates a site and adds a domain.
2. The module issues a DNS TXT or HTTP-file challenge.
3. Verification records the exact challenge, observation, and time.
4. The module produces an original runtime snippet bound to the verified site identifier.
5. Production publication is rejected for unverified domains.

### 2. Discover and classify resources

1. An editor starts a bounded scan of same-site pages.
2. The scanner records network, script, frame, cookie, and browser-storage observations without bypassing authentication or access controls.
3. Deterministic rules match known workspace services.
4. AI may suggest service and purpose classifications with evidence and confidence.
5. A human accepts, edits, ignores, or marks each relevant observation unresolved.
6. The completed run shows additions, removals, and changed evidence relative to the previous run.

### 3. Draft and publish a policy

1. The editor selects services, purposes, locale content, signals, expiration, and runtime behavior.
2. A deterministic preflight rejects missing fallback rules, unclassified governed resources, invalid URLs, duplicate keys, or a required-purpose change lacking explicit confirmation.
3. A publisher reviews a semantic diff and approves the exact content hash.
4. Publication atomically activates the revision and preserves the previous revision for rollback.
5. CDN or edge caches receive a signed, cacheable public representation.

### 4. Enforce a visitor decision

1. Runtime loads the signed policy for the exact site and domain.
2. Governed optional resources remain inert until policy rules allow them.
3. The visitor can accept all optional purposes, reject all, or choose individually.
4. Runtime applies the choice, submits an append-only receipt, and emits a local event for customer code.
5. A returning visitor receives the current choice only when it is still valid for the active policy; a material policy change requests a new choice.

### 5. Revoke or change a decision

1. The site exposes a persistent privacy-settings entry point.
2. A visitor changes or revokes purposes.
3. The runtime stops future governed resource execution where technically possible and informs registered adapters.
4. A new revocation receipt links to the prior active receipt.

### 6. Monitor drift and export evidence

1. Scheduled rescans compare observations to the active policy.
2. New or changed resources create alerts rather than silently altering policy.
3. Authorized users export policy revisions and pseudonymous receipts by bounded date/site range.
4. Retention jobs delete expired operational data and record aggregate deletion evidence.

## AI contract

### Allowed AI actions

- Suggest a service category and purpose from observation evidence.
- Summarize the difference between scans or policy revisions.
- Draft plain-language descriptions and translations marked as unreviewed.
- Explain why a resource was flagged using cited observation fields.
- Recommend review priorities based on factual drift and unresolved items.

### Forbidden AI actions

- Publish, roll back, or mark a policy legally compliant.
- Invent a vendor, data use, retention period, legal basis, or regulatory requirement.
- Change a resource rule or visitor choice without deterministic validation and authorization.
- Send visitor identifiers, full URLs containing secrets, cookies, storage values, or IP addresses to a remote model.

Every suggestion stores evidence identifiers, model metadata, confidence, and reviewer outcome. Low-confidence suggestions remain visibly unresolved.

## HTTP, CLI, and MCP surface

The original HTTP API must support sites, verification, scans, observations, services, purposes, draft revisions, approval/publication, receipts, alerts, exports, and runtime policy/decision endpoints.

Representative CLI commands:

```sh
supersuite consent site create --domain privacy.example.com --json
supersuite consent domain verify --site SITE_ID --method dns
supersuite consent scan start --site SITE_ID --url https://privacy.example.com
supersuite consent finding list --scan SCAN_ID --state unresolved
supersuite consent policy validate --revision REVISION_ID
supersuite consent policy publish --revision REVISION_ID --confirm-hash SHA256
supersuite consent receipt export --site SITE_ID --from 2026-08-01 --to 2026-08-31
```

Required MCP tools:

- `consent_site_list`
- `consent_site_create`
- `consent_scan_start`
- `consent_finding_list`
- `consent_finding_suggest`
- `consent_policy_get`
- `consent_policy_validate`
- `consent_policy_publish`
- `consent_alert_list`
- `consent_receipt_export`

`consent_policy_publish` requires an approved revision identifier, exact content hash, mutation scope, and explicit confirmation. MCP never accepts raw executable JavaScript as a service rule.

## Resource and plan contract

- Starter includes the module and ordinary scheduled scans within the workspace's shared CPU, memory, storage, and service quotas.
- Scale is recommended for many domains, frequent scans, long receipt retention, or large exports.
- Customer-owned CDN, geolocation, email, and scanning proxy costs are disclosed separately.
- The module applies backpressure to scans and exports; it never compromises runtime receipt ingestion to finish a crawl.

## Security and privacy requirements

- Runtime policy and receipt endpoints use strict origin/site binding, rate limits, replay protection, and signed payloads.
- Domain verification is mandatory before production publication.
- Receipt identifiers are pseudonymous and site-specific; they cannot correlate a visitor across customer sites.
- Raw cookie values, local-storage values, authorization headers, query secrets, and full IP addresses are never persisted by the scanner.
- Export and retention changes create privileged audit events.
- Public policy delivery remains available during control-plane restarts through a durable edge cache; stale content clearly retains its signed revision identifier.
- CSP guidance is generated as configuration advice and never silently weakens a customer's existing policy.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| CON-001 | Two workspaces register identical domains in test mode; neither can list, fetch, publish, export, or mutate the other's site or receipt data through web, HTTP, CLI, MCP, worker, or public identifiers. |
| CON-002 | A production policy publication for an unverified domain is rejected and emits an audit event without changing the active revision. |
| CON-003 | A bounded test page containing an optional governed script is loaded before consent; the script causes no network request or execution until its purpose is accepted. |
| CON-004 | Reject-all leaves required resources available and optional governed resources inert; the stored receipt references the exact signed revision and contains no raw IP or fingerprint. |
| CON-005 | Changing one optional purpose appends a new linked receipt, applies adapter changes, and leaves the prior receipt immutable. |
| CON-006 | A materially changed published purpose description invalidates an old decision according to the configured rule and requests a new choice rather than silently migrating consent. |
| CON-007 | A scan discovers a previously unseen third-party host; it creates an unresolved finding and alert but does not add the host to a published service rule. |
| CON-008 | An AI classification with no cited observations or below-threshold confidence cannot be accepted automatically and cannot enter a published revision. |
| CON-009 | A policy publish replay with the same idempotency key returns the original revision and audit identifier; a replay with a different content hash fails. |
| CON-010 | A valid GPC signal selects the configured GPC rule, and the receipt records the signal source without asserting a legal conclusion. |
| CON-011 | After a process restart, the signed public policy and prior receipts remain available and unchanged. Backup restore reproduces their content hashes. |
| CON-012 | CLI and MCP each publish the same pre-approved test revision through the HTTP authorization path and return equivalent version and audit metadata. |
| CON-013 | An expired receipt-retention batch removes eligible pseudonymous operational rows, preserves required policy/audit evidence, and records counts without retaining deleted identifiers. |
| CON-014 | Keyboard-only and screen-reader testing can open settings, understand every purpose, reject all, choose granular options, save, and reopen the current choice. |

## Implemented first slice

The shared suite currently registers this as a Starter/shared-resource module and exposes generated CLI/MCP actions for site creation and configuration, DNS domain proof, bounded scans, policy drafting and approval, exact-hash publication, append-only choices, and evidence-bound AI classification suggestions. The server engine enforces:

- DNS TXT verification through a server resolver rather than a client ownership assertion;
- same-origin, public-network-only scan queues with query strings removed before persistence;
- reviewed purpose/service snapshots with stable keys and no executable payload fields;
- unresolved governed-observation blocking, SHA-256 content addressing, approval-hash matching, and publication idempotency;
- one active policy per site, verified-domain publication, and preserved superseded revisions;
- site-scoped visitor-key hashing, complete purpose decisions, immutable prior receipts, and allowlisted signal context; and
- AI context restricted to the selected observation identifier and instruction.

The following public runtime routes remain an essential integration seam for the owner of `src/server/app.ts`; they are deliberately not simulated by an authenticated action:

- signed active-policy retrieval bound to workspace, site, and request origin; and
- rate-limited public choice/revocation submission with replay protection.

The hosted routes now publish domain-bound policies and record idempotent public choices, but the browser runtime remains a customer-integrated surface rather than a drop-in consent banner. When `CONSENT_POLICY_SIGNING_PRIVATE_KEY` is configured from the secret store, policies and receipts use Ed25519 signatures. A verifier must obtain the expected key set from the trusted origin's `/.well-known/managed-oss-public-signing-keys.json` endpoint and pass it explicitly; signatures never carry their own trust anchor. Operators retain prior public keys during rotation so historical receipts remain verifiable.

## Explicitly deferred

- Legal opinions, data-protection impact assessments, or compliance certification.
- A global vendor database copied from another consent platform.
- Identity resolution or cross-site tracking.
- Automated authenticated crawling without an explicit customer-supplied test account and scope.
- IAB Transparency and Consent Framework support until its current specification, registration obligations, and test suite receive separate legal and engineering review.
