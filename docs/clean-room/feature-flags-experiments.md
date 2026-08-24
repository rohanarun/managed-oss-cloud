# Feature flags and experiments module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `flags` |
| Working category | Feature delivery, remote configuration, and controlled experiments |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for many projects and environments, large exposure ledgers, frequent configuration publication, or recurring experiment analysis |
| License target | Original first-party source under MIT |
| Primary outcome | A product team can release a typed feature safely, evaluate the same decision everywhere, roll it back, and measure a preregistered experiment without overstating the evidence. |

This module changes application behavior and therefore treats configuration as production authority. It is not an autonomous deployment system, an ad network, a behavioral-profiling marketplace, or proof that an experiment caused a business outcome. Flag evaluation works locally from a validated last-known-good manifest and does not depend on a model or per-request network call.

## Scope

In scope are typed feature and remote-configuration values, deterministic context rules and fractional allocation, immutable reviewed environment revisions, signed client/server manifests, OpenFeature-compatible local evaluation, evaluation/exposure evidence, preregistered controlled experiments, quality-gated analysis, safe rollback, reporting, retention, and deletion. Warehouses and event transports are customer-selected adapters that do not own assignment or publication truth.

Deployments, source-code mutation, advertising optimization, regulated eligibility, arbitrary warehouse execution, secret distribution, cross-customer profiling, and automatic rollout from model or experiment output are outside the module. The final section records additional deferred work.

## Public behavioral research record

Research sources establish public standards and user-visible behavior only. They are not implementation dependencies.

- [OpenFeature specification](https://openfeature.dev/specification/) defines a vendor-neutral feature-flag API with normative sections for typed evaluation, providers, context, hooks, events, and tracking.
- [OpenFeature flag-evaluation specification](https://openfeature.dev/specification/sections/flag-evaluation/) requires typed boolean, numeric, string, and structured evaluation with caller-supplied defaults and describes detailed evaluation metadata.
- [OpenFeature evaluation-context specification](https://openfeature.dev/specification/sections/evaluation-context/) defines targeting context and precedence across global, transaction, client, invocation, and hook levels.
- [OpenFeature hooks specification](https://openfeature.dev/specification/sections/hooks/) defines before, after, error, and finally stages for validation, telemetry, and other integrations.
- [OpenFeature specification repository and Apache-2.0 license](https://github.com/open-feature/spec) is the official source and license record for the standard.
- [GrowthBook documentation](https://docs.growthbook.io/) publicly describes local SDK evaluation, self-hosting, feature release, experimentation, existing-data integration, and user-data minimization.
- [Microsoft Research guidance for trustworthy experiments](https://www.microsoft.com/en-us/research/group/experimentation-platform-exp/articles/patterns-of-trustworthy-experimentation-during-experiment-stage/) publicly describes data-quality checks, sample-ratio mismatch, overall-evaluation and guardrail metrics, and safety intervention during experiments.
- [GrowthBook license](https://github.com/growthbook/growthbook/blob/main/LICENSE) records MIT licensing outside named enterprise directories and a separate commercial license within those directories.

No GrowthBook source, enterprise code, schemas, migrations, statistical implementation, query generation, tests, fixtures, SDK internals, endpoint names, interface copy, layouts, visual design, or assets may be used. OpenFeature compatibility is implemented from its public normative specification and conformance material under its own license; required notices remain intact.

## Clean-room boundary

### Permitted inputs

- This specification and the public OpenFeature normative specification.
- Independently selected permissively licensed cryptographic, statistical, serialization, and SDK libraries after dependency review.
- General statistical literature and independently authored test vectors reviewed for license and provenance.
- Customer-authored flags, variants, rules, hypotheses, metrics, guardrails, environments, and approval policy.
- Official documentation for a customer-selected warehouse or analytics source.

### Prohibited inputs

- Reference-product source, schemas, migrations, internal APIs, evaluation engine, hashing choices, query generator, statistical code, tests, fixtures, dashboards, default metrics, or enterprise behavior.
- Reference-product UI, copy, naming, tutorials, visualizations, icons, templates, or seeded examples.
- Arbitrary JavaScript, SQL, model output, or customer code executed by the flag evaluator.
- Hidden targeting based on protected traits, inferred sensitive characteristics, purchased profiles, or cross-customer identity graphs.
- Claims of a winning or causal result when preregistered quality and stopping gates have not passed.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage projects, members, retention, warehouses, SDK credentials, production policy, raw exports, and deletion. |
| Flag admin | Define flags, environments, approval policy, manifests, and safe rollback values. |
| Developer | Draft flags and revisions, preview evaluations, use development environments, and inspect assigned projects. |
| Production approver | Review semantic diffs and approve or publish an exact production revision according to policy. |
| Experiment owner | Preregister a hypothesis, assignment, metrics, guardrails, duration, sample policy, and stopping rules. |
| Analyst | Define approved metrics, run analyses, inspect data-quality warnings, and publish evidence-bound interpretations. |
| SDK principal | Fetch a client- or server-safe manifest, evaluate flags, and submit bounded exposure/tracking events for one environment. |
| Auditor | Read immutable revision, approval, evaluation, exposure, experiment, analysis, rollback, access, export, and deletion evidence. |

An SDK credential cannot call management mutations. A client-side credential receives client-safe flags only. Production publish, emergency disable, experiment start/stop, metric changes, raw exposure export, retention, credential rotation, and deletion require explicit privileged scopes.

## Original data requirements

The implementation owns a PostgreSQL schema named `flags`. Typed tables are the configuration and experiment system of record; the generic suite graph may index them but cannot replace revision, approval, assignment, exposure, or analysis constraints.

### `flag_project` and `environment`

- Workspace-scoped project with stable key, owner, retention policy, and lifecycle state.
- Environment has stable key, class such as development/staging/production, client/server exposure policy, assignment salt, manifest-signing public key reference, approval policy, and active revision pointer.
- Environment keys are never inferred from arbitrary request input; SDK credentials bind to exact project/environment and audience.
- Retiring an environment stops new publications and credentials while preserving historical evidence.

### `flag`

- Stable project key, original name/description, owner, value type, lifecycle, client/server visibility, safe value, tags, expiry/review date, and optional experiment eligibility.
- Types: boolean, integer, finite decimal, string, and bounded structured JSON conforming to a declared schema.
- States: `draft`, `active`, `deprecated`, `archived`.
- A flag key cannot change type or be recycled for a different semantic meaning after publication. Migration requires a new key.

### `variant`

- Flag, stable variant key, typed value, description, and lifecycle.
- A variant value must exactly match the flag type and structural schema.
- Production manifests contain no secret value. Server-side secrets use a separate secret store and are not feature-flag variants.
- Experiment variants are immutable during an assignment epoch.

### `targeting_rule`

- Revision, flag, priority, typed predicate tree, rollout definition, resulting variant, and optional validity window.
- Predicates use an allowlisted context schema and bounded operators such as equality, set membership, numeric/date comparison, semantic version comparison, and safe string matching.
- Fractional allocation uses integer units with an exact declared denominator; weights are non-negative and sum exactly to the allocated range.
- Rule evaluation order, missing/null/type-error behavior, and fallback are explicit and deterministic.
- Protected traits, inferred sensitive attributes, unbounded regular expressions, network access, code, and model calls are invalid.

### `config_revision`

- Project/environment, monotonically increasing version, complete flag/rule/variant snapshot or canonical delta plus base hash, author, state, validation result, semantic diff, content hash, and publication clock.
- States: `draft`, `validated`, `approved`, `published`, `superseded`, `withdrawn`, `rejected`.
- A published revision is immutable. One revision is active per environment.
- Production publication requires approval records for the exact content hash and optimistic base version.

### `approval`

- Revision/hash, actor, role, decision, reason, policy version, time, and optional expiry.
- Any revision change invalidates prior approval. An actor cannot satisfy two distinct approver roles in the same policy step.
- Development policy may permit self-publication; production defaults to separate author and approver.

### `manifest`

- Environment/revision, audience class, canonical serialized flag configuration, content hash, signature, creation/expiry, schema version, and last-known-good eligibility.
- Client manifests exclude server-only flags, internal descriptions, approvals, experiment hypotheses, private context definitions, and credentials.
- A manifest is accepted only after schema, signature, audience, version, and environment checks.
- SDKs cache the latest accepted manifest and preserve it when a newer fetch or parse fails.

### `evaluation_receipt`

- Optional privacy-safe receipt containing environment/revision, flag key, variant, reason code, matched rule, assignment epoch, subject-key digest when needed, context-schema version, evaluator version, and clock.
- Raw evaluation context is not stored by default.
- Reasons distinguish target match, fractional allocation, default rule, disabled flag, missing flag, type mismatch, stale manifest, and error fallback.
- High-volume receipt retention is configurable and sampled independently from the decision itself.

### `exposure`

- Experiment, assignment epoch, pseudonymous subject digest, variant, first-exposure time, revision, source event identifier, and data-quality state.
- A uniqueness rule prevents duplicate first exposures for the same experiment, epoch, and subject.
- Multiple-variant exposure is retained as a quality warning, not silently reassigned.
- Pseudonyms are workspace/project scoped so they cannot form a cross-customer identity graph.

### `metric_definition`

- Stable metric key, owner, source, versioned query or typed event definition, population unit, numerator/denominator, aggregation, direction, attribution window, outlier policy, minimum-data policy, privacy class, and validation state.
- Warehouse query text, when supported, is created and approved through a separate restricted connector path; MCP never accepts arbitrary SQL for execution.
- A metric version used by a started experiment is immutable.

### `experiment`

- Flag and assignment epoch, original hypothesis, variants and planned weights, eligibility rule, unit of assignment, primary metric version, secondary metrics, guardrails, minimum duration/sample, analysis family, error-rate policy, stopping rule, owner, approvers, and state.
- States: `draft`, `approved`, `running`, `paused`, `stopped`, `analyzing`, `concluded`, `invalidated`, `archived`.
- Starting freezes the experiment contract. Material changes create a new epoch and do not pool evidence silently.
- A conclusion stores human interpretation separately from calculated results.

### `analysis_run`

- Experiment/epoch, immutable exposure and outcome cutoffs, metric/query versions, engine version, method parameters, sample counts, exclusions, missingness, SRM result, multiple-exposure result, guardrail results, estimates and uncertainty, gate states, warnings, reproducibility hash, and clock.
- The engine's mathematical contract and numerical tolerances are documented and independently tested.
- A run cannot return `winner` or equivalent causal language while any required quality, sample, duration, or stopping gate fails.
- Re-running with the same frozen inputs and engine version yields the same output.

### `rollback_event` and `emergency_disable`

- Rollback records source and target revisions, actor, reason, approval or emergency policy, time, and publication result.
- Emergency disable may only move an eligible flag to its predeclared safe value, within the actor's environment scope, and creates an immutable high-priority audit event.
- Emergency authority cannot enable a feature, change targeting, edit variants, or erase the prior revision.

## Required workflows

### 1. Define a typed flag

1. A developer chooses a permanent key, type/schema, safe value, audience, owner, expiry/review date, and initial variants.
2. Deterministic validation rejects invalid values, secret-like content, reused keys, unsupported schema features, unsafe client exposure, and missing safe values.
3. AI may draft a description, test matrix, or rollout proposal, but no proposal becomes configuration automatically.
4. The draft records an original change reason and links to customer-owned work evidence.
5. The flag can be evaluated in a development environment before production exists.

### 2. Draft, review, and publish configuration

1. An authorized developer creates rules and fractional allocations against the environment context schema.
2. Validation evaluates types, operator bounds, rule reachability, exact weights, safe fallback, experiment conflicts, and manifest size.
3. The system produces a semantic diff and deterministic evaluation vectors for reviewer inspection.
4. Approvers sign off on the exact content hash and base revision.
5. Publication atomically advances the active revision, creates signed audience manifests, invalidates changed approvals, and preserves rollback lineage.

### 3. Evaluate locally

1. An SDK principal fetches a manifest for its exact project, environment, and audience and verifies schema/signature/version.
2. The OpenFeature-compatible provider merges applicable evaluation context using documented precedence.
3. The evaluator validates the requested type, walks rules deterministically, performs stable fractional assignment, and returns a typed value.
4. Detailed evaluation may return revision, variant, reason, and matched-rule metadata without secrets or full context.
5. Missing, malformed, wrong-type, or unavailable configuration returns the caller's supplied default with an explicit reason and never crashes the application because of management-plane availability.

### 4. Distribute and recover configuration

1. Publication emits immutable manifest-change events and cache validators.
2. SDKs poll or stream only as an optimization; evaluation uses the accepted local snapshot.
3. A corrupt, unsigned, wrong-audience, future-incompatible, or partially downloaded manifest is rejected.
4. The SDK retains the last-known-good manifest and surfaces staleness/health separately.
5. Rollback republishes a prior validated state as a new monotonic revision so history never moves backward invisibly.

### 5. Preregister and start an experiment

1. The owner records hypothesis, assignment unit, eligibility, variants, weights, metric versions, attribution, guardrails, minimum sample/duration, analysis family, and stopping policy.
2. Deterministic preflight rejects mutable metrics, overlapping incompatible experiments, protected-trait targeting, missing safe behavior, inconsistent units, and insufficient approval.
3. Start freezes an assignment epoch and publishes the exact related flag revision through the production approval path.
4. Stable subject assignment remains constant throughout the epoch.
5. Changing variants, weights, eligibility, unit, primary metric, or assignment salt ends or invalidates the epoch and requires a new one.

### 6. Record exposure and outcomes

1. An exposure is recorded only when the application actually reaches the declared exposure point, not merely when a manifest is fetched.
2. The SDK or trusted server sends event identifier, experiment/epoch, variant, pseudonymous subject, revision, and time.
3. The server validates assignment consistency, deduplicates first exposure, and flags conflicting multi-variant exposure.
4. Outcome data arrives through a typed event or approved connector and remains separate from assignment evidence.
5. Late, missing, duplicate, and invalid events are classified explicitly rather than silently coerced.

### 7. Analyze and conclude

1. An analyst freezes exposure and outcome cutoffs and selects the preregistered analysis contract.
2. The engine checks sample-ratio mismatch, duplicate/multiple exposure, variant/version mismatches, missingness, attribution, minimum sample, minimum duration, and guardrails before inference.
3. Results show counts, estimates, uncertainty, exclusions, warnings, and every gate status.
4. If a required gate fails, the result is `insufficient` or `invalidated`; it cannot identify a winner.
5. An authorized human records a conclusion and decision separately, with acknowledgement of warnings and no automatic production rollout.

### 8. Disable, roll back, and clean up

1. A normal rollback previews impact and follows the environment's approval policy.
2. Emergency disable is available only for a predeclared safe value and records immutable reason/evidence immediately.
3. SDKs receive the new monotonic revision and preserve both prior and new receipts.
4. Stale-flag review identifies expired, permanently uniform, or unused flags as evidence-backed suggestions.
5. Archival requires proof that supported applications no longer request the key; it never silently reuses the key.

### 9. Export, retain, and delete

1. An authorized user previews bounded configuration, receipt, exposure, experiment, or analysis exports with privacy classes and row estimates.
2. Export binds to an exact snapshot/hash and produces a short-lived encrypted artifact.
3. Retention can aggregate or delete detailed evaluation/exposure data while preserving non-identifying revision and analysis provenance.
4. Subject deletion removes eligible pseudonyms/outcomes and marks affected analyses without rewriting their historical inputs invisibly.
5. Backup/restore preserves active revision, signatures, approvals, assignment epochs, idempotency, and deletion tombstones.

## Public and SDK surfaces

- Management HTTP endpoints are authenticated and never exposed through client SDK credentials.
- A signed manifest endpoint is bound to project, environment, audience, credential, schema version, and cache validator.
- An optional event stream announces a newer manifest version but carries no management data and is not required for evaluation.
- Exposure/tracking endpoints accept only allowlisted event schemas, bounded batches, trusted environment credentials, idempotency identifiers, and pseudonymous subjects.
- A standards adapter implements the applicable OpenFeature provider, typed evaluation, details, context, hooks, events, and tracking contracts from the public specification.
- Client manifests never include server-only flags, secrets, raw experiment hypotheses, approvals, member identities, private metric definitions, or warehouse queries.
- Public/SDK endpoints use uniform non-enumerating errors, strict rate and payload limits, credential rotation, replay controls, and cross-origin policy appropriate to the audience.

## AI contract

### Allowed AI actions

- Draft a flag description, hypothesis, targeting proposal, rollout checklist, test matrix, or cleanup plan for review.
- Explain an exact evaluation receipt or configuration diff using cited revision, rule, variant, and context-schema fields.
- Summarize a completed analysis using its exact counts, gates, estimates, uncertainty, warnings, and clock.
- Suggest potentially stale flags, conflicting rules, missing guardrails, or risky audience exposure.
- Draft human-readable release notes without publishing them.

### Forbidden AI actions

- Publish, approve, withdraw, roll back, emergency-disable, start/stop/conclude an experiment, rotate credentials, export raw data, or change permissions.
- Execute or generate arbitrary warehouse SQL through MCP, mutate metric data, or alter assignment/exposure facts.
- Invent flag state, evaluation reasons, exposure counts, outcomes, statistical significance, confidence, causality, or a winner.
- Target or segment using protected traits, inferred sensitive characteristics, sentiment, purchased profiles, or undisclosed scoring.
- Receive SDK secrets, signing keys, raw warehouse credentials, unrestricted evaluation context, or unnecessary row-level outcomes.
- Override quality gates or recommend an automatic rollout as if an experiment result were authorization.

Every AI output stores the exact allowlisted revision, rule, experiment, analysis and query/result identifiers, model metadata, prompt-template version, redactions, proposal, and reviewer outcome. Evaluation, assignment, validation, publication, quality gates, and rollback are deterministic and model-independent.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite flags project create --key storefront
supersuite flags flag create --project PROJECT_ID --key checkout-v2 --type boolean --safe-value false
supersuite flags revision validate --revision REVISION_ID
supersuite flags rollout preview --revision REVISION_ID --vectors contexts.json
supersuite flags revision approve --revision REVISION_ID --confirm-hash SHA256
supersuite flags revision publish --revision REVISION_ID --confirm-hash SHA256 --confirm-base VERSION
supersuite flags evaluate --environment production --flag checkout-v2 --type boolean --default false --context context.json
supersuite flags experiment start --experiment EXPERIMENT_ID --confirm-version VERSION
supersuite flags experiment analyze --experiment EXPERIMENT_ID --cutoff 2026-10-01T00:00:00Z
supersuite flags revision rollback --environment production --target REVISION_ID --confirm-hash SHA256
```

Required MCP tools:

- `flags_project_list`
- `flags_flag_draft`
- `flags_revision_validate`
- `flags_rollout_preview`
- `flags_revision_diff`
- `flags_revision_approve`
- `flags_revision_publish`
- `flags_evaluate`
- `flags_evaluation_explain`
- `flags_manifest_export`
- `flags_exposure_record`
- `flags_experiment_draft`
- `flags_experiment_start`
- `flags_experiment_analyze`
- `flags_revision_rollback`
- `flags_stale_review`

Production approval/publication, experiment start/stop/conclusion, emergency disable, rollback, raw exports, metric connector changes, credential rotation, retention, and deletion require human-only scopes and exact version/hash confirmation. AI-capable tokens cannot acquire those scopes through an MCP call.

## Resource and plan contract

- Starter supports normal small-business projects, environments, flags, signed manifests, local evaluation, bounded exposure retention, and occasional experiments within pooled quotas.
- Scale is recommended for many projects/environments, high manifest fan-out, large exposure/event volume, long retention, many concurrent experiments, or repeated warehouse analysis.
- Fleet is capacity or isolation guidance for sustained enterprise-scale event ingestion and analysis; it does not weaken approvals or evidence gates.
- Warehouse queries, event transport, object storage, CDN traffic, and customer analytics providers are separately metered or customer-funded.
- The management plane may batch, cache, and queue distribution, but SDK evaluation latency and availability must not depend on a per-evaluation hosted request.

## Security, privacy, and statistical-integrity requirements

- PostgreSQL row-level security scopes every project, environment, flag, revision, manifest, exposure, metric, experiment, analysis, and export.
- Client/server SDK credentials are environment- and audience-bound, minimally scoped, rotatable, hashed or secret-store-backed, and never accepted for management mutation.
- Manifests are canonicalized, content-addressed, signed, versioned, size-bounded, and parsed without executable code or prototype/object injection.
- Structured variants and context accept only documented JSON types, depth, key count, and byte limits.
- Assignment is deterministic across supported SDKs using one documented algorithm and shared conformance vectors; floating-point rounding is not used for bucket boundaries.
- Evaluation context is allowlisted and minimized. Raw emails, IP addresses, advertising identifiers, precise location, protected traits, and secrets are excluded by default.
- Exposure and outcome identifiers are project-scoped pseudonyms with rotation/deletion policy; they cannot create a cross-workspace profile.
- Experiment methodology, thresholds, exclusions, clocks, engine version, numerical tolerances, and stopping rules are versioned and exportable.
- Results distinguish descriptive association from causal interpretation and suppress winner language whenever preregistered validity gates fail.
- Raw warehouse access is isolated from MCP/AI, uses approved query definitions, statement/time/row limits, read-only credentials, and redacted logs.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| FLG-001 | Two workspaces with identical project, environment, flag, subject, and experiment keys cannot fetch, evaluate, mutate, expose, analyze, export, or infer each other's data through web, HTTP, CLI, MCP, SDK, worker, stream, or cache paths. |
| FLG-002 | Boolean, integer, decimal, string, and structured flags return only the declared type; a missing flag or wrong-typed provider value returns the caller default and explicit reason without abnormal application termination. |
| FLG-003 | The same environment revision, flag, context, subject key, and assignment epoch produces the same variant across server and supported client SDK conformance vectors, including every fractional bucket boundary. |
| FLG-004 | Fractional weights that are negative, overflow, leave an unintended gap, or fail to sum exactly are rejected before approval/publication. |
| FLG-005 | Missing, null, type-mismatched, and malformed context follow documented rule semantics; unbounded patterns, executable values, protected-trait predicates, and undeclared attributes cannot publish. |
| FLG-006 | Changing any byte or semantic field after approval invalidates that approval; publishing a stale base version or mismatched hash fails atomically and leaves the active manifest unchanged. |
| FLG-007 | A client credential cannot fetch server-only flags, management metadata, experiment hypotheses, approvals, metric definitions, member data, or another environment's manifest. |
| FLG-008 | A corrupt, unsigned, wrong-audience, incompatible, or partial new manifest is rejected while the prior last-known-good manifest continues evaluating and reports staleness separately. |
| FLG-009 | Rollback creates a new monotonic revision with preserved source/target lineage; it never rewrites the active-version clock backward or erases intervening evidence. |
| FLG-010 | Emergency disable can set only the flag's predeclared safe value, requires authorized scope/reason, and cannot enable, retarget, change variants, or erase the prior revision. |
| FLG-011 | Replayed exposure events and repeated batches create one first exposure per experiment/epoch/subject; conflicting multiple-variant exposure remains visible as a quality warning. |
| FLG-012 | A material change to variants, weights, eligibility, assignment unit, primary metric, or salt cannot silently pool evidence and instead requires a new assignment epoch. |
| FLG-013 | An experiment with sample-ratio mismatch, insufficient sample, insufficient duration, multiple-exposure failure, metric-version mismatch, or failed required guardrail cannot return a winner or causal claim. |
| FLG-014 | Re-running an analysis with the same frozen inputs, cutoffs, metric versions, method parameters, and engine version produces the same counts, gates, estimates, uncertainty, warnings, and reproducibility hash within declared numerical tolerances. |
| FLG-015 | AI explanations cite exact revision/rule/variant or analysis/gate fields and cannot approve, publish, disable, roll back, start/stop/conclude, execute SQL, or declare a winner through AI scope. |
| FLG-016 | CLI, MCP, HTTP, and OpenFeature-compatible evaluation return the same typed value and detailed reason for the same manifest/context; management mutations return the same hashes, versions, audit identifiers, and permission failures. |
| FLG-017 | Deleting an eligible pseudonymous subject removes detailed exposure/outcome data, marks affected analyses according to policy, and cannot resurrect the subject through restore or reingestion. |
| FLG-018 | Backup/restore preserves active revisions, signatures, approvals, assignment epochs, uniqueness, exposure warnings, analysis inputs/results, credential revocations, outbox idempotency, and deletion tombstones. |
| FLG-019 | With AI, network streaming, and external analytics providers disabled, users can draft/approve/publish flags, distribute a signed file manifest, evaluate locally, roll back, export configuration, and audit every change. |
| FLG-020 | Keyboard-only and screen-reader users can inspect a semantic diff, review evaluation vectors, approve/publish with clear consequences, inspect gate failures, and execute a bounded safe rollback. |

## Explicitly deferred

- Autonomous deployment, code modification, traffic routing outside flag evaluation, or automatic production rollout from an experiment.
- Advertising optimization, protected-class targeting, credit/employment/insurance/health eligibility, surveillance, or cross-customer profiling.
- Arbitrary SQL through MCP or AI, write access to customer warehouses, or a copied warehouse query generator.
- Session replay, general product analytics, attribution marketing, or a cross-product identity graph.
- Secret management through flag variants or delivery of credentials in client manifests.
- Proprietary reference SDK behavior beyond the public OpenFeature contract.
