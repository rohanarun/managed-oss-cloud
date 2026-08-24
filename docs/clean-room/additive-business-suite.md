# Shared business graph clean-room record

## Boundary

This record covers five original first-party modules: SchemaDeck (`tables`), Recall Room (`meetings`), Proofline Insights (`insights`), Learning Forge (`learning`), and Circlefield (`community`). Their names, schemas, action vocabulary, state transitions, tests, and implementation are original to this repository. Public relational-data, meeting-ledger, business-intelligence, learning-management, and community patterns supplied category context only. No reference-product source, schema, UI, copy, assets, route names, fixtures, or tests were used.

All five modules persist through the shared tenant `SuiteStore`. The plan boundary is Starter for SchemaDeck and Scale for the other four. The registry copies each module's declared resource class and exact CPU, memory, storage, and concurrency guidance; those values are hosted capacity guidance, not dedicated per-customer machines.

## SchemaDeck

SchemaDeck provides governed bases, typed fields and rows, deterministic views, bounded import previews, exact approved imports, deterministic aggregates, and version-pinned schema proposals. It never runs arbitrary formulas or lets a model add fields or change rows.

## Recall Room

Recall Room stores meeting purpose, privacy class, participants, transcript provenance, human decisions, owned action items, private exports, and review-only summaries or follow-ups. Transcript redaction requires optimistic locking and attributed approval; a model cannot record a decision, assign work, send a message, or redact evidence.

## Proofline Insights

Proofline Insights defines governed sources and metrics, append-only observations, deterministic charts and inert alerts, immutable reporting clocks, and cited anomaly or narrative proposals. Measurements remain separate from hypotheses, and no model can rewrite a metric, observation, alert, or snapshot.

## Learning Forge

Learning Forge binds courses, cited lessons, enrollments, rubrics, attempts, feedback proposals, learning-path proposals, and credentials. Scores and credential eligibility are deterministic. A credential is issued only after an exact preview and attributed approval.

## Circlefield

Circlefield provides purpose-bound spaces, membership, posts, replies, reactions, human moderation, reviewed announcements, and proposal-only digests. Hiding, role changes, and publication retain explicit receipts or approvals; models cannot silently post, hide, ban, promote, or publish.

## Shared evidence and AI rules

- An AI request contains an exact tenant-owned evidence selection and a versioned prompt contract.
- The claim path may cross module boundaries only when record IDs were explicitly selected. A request with no selection remains module-local.
- Cross-workspace records cannot be loaded, and unselected records in an allowed module are excluded.
- Model output must be a cited proposal with confidence and assumptions. The worker pins the actual model and forces `pending-human-review`, `proposalOnly=true`, `automaticMutationAllowed=false`, and `externalEffectAllowed=false`.
- A proposal has no generic apply action. Consequential changes still use their separately authorized typed action.

## Review checklist

1. Every non-read action remains idempotent in the tenant store.
2. Every destructive or consequential action retains its dry-run and attributed approval boundary.
3. New record types are added to the shared registry and remain tenant scoped.
4. AI tests cover exact evidence selection, cross-tenant denial, unselected-record denial, and proposal-only result validation.
5. CLI and MCP schemas continue to derive from the same action definitions used by the HTTP dispatcher.
