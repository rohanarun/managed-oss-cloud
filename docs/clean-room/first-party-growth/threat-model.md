# First-party growth threat model

## Security goals

- A caller cannot read or mutate another workspace's growth records.
- A retry cannot duplicate a command or silently change its meaning.
- A viewer cannot mutate; a non-admin cannot approve high-risk public changes.
- A model cannot fabricate completed work, change eligibility, publish content, contact people, or change destinations.
- Revoked testimonial or contest consent is reflected in every managed public surface.
- A contest winner can be reproduced from retained inputs and an immutable candidate digest.
- Public analytics contain coarse aggregate counts, not raw visitor identity or fingerprints.
- A QR or page destination cannot directly target a syntactically local or IP-literal host.

## Trust boundaries

1. **Authentication boundary** supplies the user ID, workspace ID, current role, and scopes. The engine rechecks these against `SuiteStore` before dereferencing a record.
2. **Database boundary** owns tenancy, row-level security, record quotas, AI quotas, transactions, and durable receipts. `runInWorkspaceTransaction` serializes a workspace operation and is the atomicity seam for PostgreSQL.
3. **Model worker boundary** receives a persisted prompt/evidence envelope. It may return only a proposal. The completion recorder checks the prompt digest and authorized evidence before persisting model/review provenance.
4. **Hosted public boundary** renders approved versions, collects submissions, resolves QR routes, and records aggregate events. It must recheck current version state and consent on every response.
5. **Internet destination boundary** is untrusted. The engine performs no network fetch. Redirect infrastructure resolves the current A/AAAA set and rejects private/reserved answers immediately before its one 302. Page links use a non-automatic external-navigation interstitial. The server does not follow redirect hops and cannot pin a later browser DNS lookup.

## Principal threats and controls

### Cross-tenant record reference

An attacker supplies another tenant's UUID as a contest, entry, testimonial, widget, page, or destination. All references use tenant-bound `SuiteStore.getRecord`; a missing or mismatched record fails before action-specific behavior. PostgreSQL row-level security remains the final database enforcement layer.

### Idempotency replay and equivocation

Concurrent requests may carry the same key, or a client may reuse a key with modified input. The engine runs inside the workspace transaction and searches durable `growth-command-receipt` records. Exact hash matches replay stored result IDs; a different action or request hash fails closed. Process-local memory is not part of correctness.

### Approval bypass

Every destructive or public-surface action requires `dryRun`. Live execution requires an approval object bound to the authenticated actor and a unique decision ID. Owner/admin role is checked independently. A dry run applies no business-state mutation, though it intentionally stores its audit receipt.

### Contest manipulation

An organizer could alter entrants, weights, or entropy after learning a result. The entropy commitment is fixed when the contest is created, entries close before the candidate snapshot, fraud signals must have human decisions, and the contest becomes `draw-frozen`. The draw recomputes candidate state and requires its digest to equal the frozen digest. A consent revocation before selection invalidates that snapshot and requires a new freeze; revocation after selection preserves the completed opaque proof while suppressing the participant record. SHA-256 rejection sampling avoids modulo bias. A malicious operator can still choose or misrepresent caller-supplied public entropy; the proof therefore stores its value, source, and observation clock and does not assert that source independence was verified.

### Protected-trait discrimination

Fraud signals use a fixed behavior/attestation taxonomy. The engine rejects observation summaries containing protected-trait, raw contact, IP, fingerprint, or biometric language. Signals never mutate eligibility. Only a reasoned, approved human decision can do so. The model policy explicitly forbids protected-trait and proxy inference and cannot apply its proposal.

### Consent laundering or stale publication

Exact consent receipts link a policy version, purpose, clock, and capture method. Testimonial publication requires the current moderated evidence and a non-revoked consent record. Revocation marks source, versions, and affected widgets non-public in the same workspace transaction. Public renderers must filter by current record state rather than cache a stale `public` bit indefinitely.

### Fabricated testimonials or model claims

Original submission evidence is immutable in practice: moderation creates a separate decision, and publication creates a separate version. AI work is queued with selected evidence and a prompt digest; the queue result initially has no model output. Completion requires actual model identity, citations limited to authorized evidence, confidence, assumptions, and `pending-human-review`. Publication is a separate approved command.

### Stored script or markup injection

Widget and page schemas accept typed text, colors, layout enums, and destination-version IDs. They do not accept arbitrary HTML, CSS, or JavaScript. Embed generation HTML-escapes the title and pins IDs in URL path components. Renderers must continue to use text nodes and restrictive content security policy.

### SSRF, open redirect, and DNS rebinding

Destination creation requires a credential-free HTTPS hostname with no nonstandard port and rejects IP literals plus local hostname suffixes. It performs no fetch and marks each destination `requiresResolutionCheckAtUse`. The serving boundary resolves both A and AAAA immediately before short-link and QR redirects and rejects loopback, link-local, private, multicast, documentation, benchmark, metadata, and otherwise non-global answers. Page anchors point to a checked, explicit interstitial instead of directly navigating. No server-side redirect chain is followed. DNS can change after a successful check and before the browser connects, so this is a current-resolution guard and explicit-decision boundary, not a claim of browser network pinning.

### Analytics re-identification

Event schemas expose only allowlisted dimensions and daily aggregate counts. Unknown fields are rejected. Participant or visitor keys are not accepted by event actions, and deterministic allocation does not persist an event. Operators should suppress or coarsen low-count aggregates at reporting time and apply retention limits.

### Capability-link leakage

Collection-request tokens are randomly generated, hashed in the request record, and returned only to the authenticated caller/receipt. They must be transmitted only over HTTPS, compared by hash, expire at the recorded time, and become single-use when a request is consumed. Logs must redact query strings.

## Known limits before public launch

- Public routes now resolve approved FairLaunch contests, token-bound ProofPort submissions and widgets, and approved BeaconPage page/QR versions through the tenant-scoped store. This is source-level behavior, not evidence that the current hosted preview contains the release.
- Current DNS validation belongs to the hosted serving boundary, not the storage engine; later browser resolution remains outside server control.
- Candidate snapshots store a digest rather than a full candidate list to stay below the per-record payload limit; verification depends on frozen source records remaining immutable under all legacy/public write paths.
- The public-entropy source is recorded, not independently authenticated by this engine.
- Public write routes have process-local rate limiting. A multi-replica deployment still needs a shared atomic limiter, and proxy/APM/access logs must redact capability-token query strings.
- Aggregate reports need a minimum cohort threshold to reduce re-identification risk.
- Migrations add database uniqueness for command idempotency, active contest participants, testimonial source hashes, page/QR slugs, and collection-token hashes. The store still scans tenant records for several lookups; add indexed repository methods and pagination before sustained high-volume use without weakening those database constraints.

These are launch gates, not claims of completed protection.
