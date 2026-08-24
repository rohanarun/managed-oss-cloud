# First-party growth product specification

## Shared contract

All three products use the customer's existing `SuiteStore` workspace and therefore share one tenant database while retaining module and workspace isolation. Every non-read action requires a caller-provided idempotency key. The engine runs it inside `SuiteStore.runInWorkspaceTransaction`, stores a tenant-owned `growth-command-receipt`, and rejects reuse of the same key with different input.

High-risk or public-surface changes require `dryRun`. A dry run validates the exact references and returns the planned effect while persisting only its command receipt. A live execution requires an attributable owner/admin approval containing the actor ID, unique decision ID, and reason. These actions change only the hosted public surface; no action contacts a third-party provider.

AI actions persist the approved prompt ID, prompt version, prompt digest, model policy, selected evidence IDs, target record, forbidden autonomy, versioned `first-party-growth-ai-result.v1` result contract, and review state before queueing. A queued action contains no model answer. A completion is accepted only after the worker records the same result-contract version, an executed model, bounded confidence, authorized citations, assumptions, and `pending-human-review` status.

## FairLaunch

FairLaunch provides contest creation and version publication, privacy-minimized entry registration, explicit purpose consent, referral attribution, bounded fraud signals, human eligibility decisions, cryptographic draw proofs, deterministic experiments, aggregate events, and private exports.

| Action | Behavior |
| --- | --- |
| `contest-create` | Freezes rules, close time, consent policy, referral cap, and organizer entropy commitment before entries. |
| `contest-publish` | Publishes the exact content-addressed rule version with approval. |
| `entry-register` | Stores a pseudonymous participant hash, consent receipt, referral code, and capped weight. |
| `entry-consent-revoke` | Removes eligibility and referral weight; it invalidates an undrawn snapshot and retains an already completed proof. |
| `fraud-signal-record` | Stores an enumerated behavior or attestation signal for human review; no automated exclusion. |
| `eligibility-decide` | Records an attributable human decision with expected-version protection. |
| `draw-snapshot-freeze` | Closes entries and stores candidate count, weight total, and canonical candidate digest. |
| `winner-draw-reveal` | Verifies the organizer commitment, mixes documented public entropy, and uses SHA-256 rejection sampling. |
| `referral-variant-allocate` | Computes a deterministic weighted allocation without visitor persistence. |
| `aggregate-event-ingest` | Stores deduplicated coarse daily counts with allowlisted dimensions. |
| `fraud-review-propose` | Queues a protected-trait-free, evidence-cited proposal that cannot decide eligibility. |
| `contest-export-manifest` | Stores a private content-addressed export manifest. |

Draw verification inputs are the contest ID, frozen snapshot ID, candidate digest, organizer entropy reveal, public entropy, its source URL, and its observation time. The proof records the seed hash, rejection counter, selected weighted index, winner token, and algorithm version. The internal winner entry ID is not part of the public token. The engine does not claim that a caller-supplied beacon is independently trustworthy; the source and clock are retained for auditors.

## ProofPort

ProofPort separates original evidence from review decisions and public versions. Revocation invalidates every publication and widget that references the statement.

| Action | Behavior |
| --- | --- |
| `collection-create` | Defines purpose, consent policy, locale, and retention. |
| `request-draft` | Creates a capability URL but sends no message and calls no provider. |
| `submission-record` | Stores exact evidence, source hash, attribution choice, and consent receipt as non-public. |
| `consent-revoke` | Unpublishes all affected publication and widget versions. |
| `moderation-decide` | Preserves the original while recording accept, reject, or redact decisions. |
| `publication-version-create` | Content-addresses the exact human-reviewed quote and attribution. |
| `publication-publish` | Publishes an approved consent-valid version. |
| `widget-version-create` | Creates a typed layout/theme; arbitrary HTML and script are not accepted. |
| `widget-publish` | Publishes one pinned widget version and supersedes the prior version for its key. |
| `embed-code-read` | Returns a version-pinned script or sandboxed iframe from the configured origin. |
| `aggregate-event-ingest` | Stores aggregate-only surface events. |
| `review-highlights-propose` | Queues exact-quote/cited-theme proposals and forbids invented endorsements. |

## BeaconPage

BeaconPage separates stable routes from immutable content and destination versions. A QR image resolves a stable route; changing the destination creates and activates a new audited version rather than overwriting history.

| Action | Behavior |
| --- | --- |
| `page-create` | Creates a private stable slug and privacy mode. |
| `destination-version-create` | Creates a content-addressed public-HTTPS link destination without fetching it. |
| `page-version-create` | Creates typed content, layout, theme, and destination references. |
| `page-version-publish` | Publishes one exact version and supersedes its prior public version. |
| `qr-route-create` | Creates a stable QR slug and typed visual configuration. |
| `qr-destination-version-create` | Appends a safe destination version and campaign metadata. |
| `qr-destination-activate` | Activates one exact destination and retains prior versions. |
| `route-disable` | Removes a page or QR route from public service without deleting history. |
| `aggregate-event-ingest` | Stores allowlisted coarse counts without IPs or fingerprints. |
| `variant-allocate` | Computes stable weighted allocation from a caller-provided pseudonymous hash. |
| `embed-code-read` | Returns a sandboxed page-version embed pinned to the configured origin. |
| `page-copy-propose` | Queues evidence-grounded copy and cannot create, fetch, or activate URLs. |

URL validation requires HTTPS, a DNS hostname, no credentials, and no nonstandard port; it rejects IP literals and local/reserved hostname suffixes. The engine never fetches the destination. The serving boundary must resolve and revalidate destinations immediately before use to defend against DNS rebinding.

## Integration signature

```ts
executeFirstPartyGrowthAction(
  store: SuiteStore,
  auth: FirstPartyGrowthAuthorization,
  moduleId: string,
  actionId: string,
  input: Record<string, unknown>,
  deps?: Partial<FirstPartyGrowthEngineDependencies>,
): Promise<FirstPartyGrowthExecutionResult>
```

The central action registry appends `firstPartyGrowthActions`, marks the three modules with the growth engine, and routes all 36 action IDs to this function. The HTTP application passes the configured public application origin as `deps.publicBaseUrl`; request and embed URL generation fails closed when it is absent. Public endpoints re-resolve current approved records and consent through `PublicGrowthService`; their presence in source is not proof that an older hosted release has deployed them.
