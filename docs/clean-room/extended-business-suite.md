# Governed operations clean-room record

## Boundary

This record covers five original first-party modules: GatherLedger (`events`), PeopleWeave (`people`), MeterProof (`metering`), AssureGraph (`assurance`), and LiveForum (`live`). Their names, schemas, workflows, receipts, tests, and implementation are original to this repository. Public event, HRIS, metering, assurance, and livestream patterns supplied category context only. No reference-product code, schema, copy, branding, visual assets, endpoint vocabulary, fixtures, or tests were used.

GatherLedger and PeopleWeave require Scale. MeterProof, AssureGraph, and LiveForum require Fleet. Every module uses the shared tenant `SuiteStore`; the registry preserves its declared high or accelerated resource class and exact CPU, memory, storage, and concurrency guidance.

## Source and hosted status

This document describes the current source contract, not the currently deployed managed-service release. As of the repository's 2026-08-24 verification, [cloud.getsupers.com](https://cloud.getsupers.com) was still serving the older dry-run release and did not expose this Extended-suite implementation. A future deployment must verify its image provenance, migrations, routes, configured evidence adapters, and end-to-end workflows before claiming these modules are live.

## GatherLedger

GatherLedger records event drafts and releases, ticket inventory, reservations, checkout commands, verified payment and refund receipts, tickets, and check-ins. Money and access facts come only from explicit receipts. The engine does not call a payment, ticketing, or gate provider and AI attendee updates remain unpublished proposals.

## PeopleWeave

PeopleWeave records profiles, onboarding, immutable policies and acknowledgements, leave requests and human decisions, attendance and corrections, reviews, access-revocation receipts, growth proposals, and offboarding. Employment and access decisions require accountable humans; a model cannot approve leave, score a worker, revoke access, or offboard anyone.

People records are protected even while the engine is inside a trusted workspace transaction. Owners and administrators can read protected People records. A represented person can read their own profile and subject-bound records; named participants such as an onboarding owner, reviewer, submitter, approver, or verifier can read only the records whose identity policy names them. The profile privacy values have these current authorization meanings:

- `manager-and-person`: the represented person and named manager can read the profile and its denormalized child records, alongside owners and administrators and any explicitly named participant.
- `people-team`: the represented person and privileged People operators (currently workspace owners and administrators) can read the profile; it does not grant access to every workspace member. Child records remain available only to their subject and explicitly named participants.
- `restricted`: the represented person, owners and administrators, and an explicitly named participant where a child-record contract requires one can read the record. A manager is not granted access merely because they are a manager.

Published People policies are workspace-readable. Internal command receipts, audit records, and AI request records are not ordinary member-visible records. Target and evidence visibility is rechecked for both human review submission and AI proposal actions so a trusted transaction cannot be used to select a neighboring employee's private record.

## MeterProof

MeterProof stores usage meters and immutable events, reproducible aggregates, reviewed plans, deterministic charge previews, subscriptions, credits, invoices, and payment receipts. Integer minor units and frozen evidence drive totals. A model may explain or propose, but cannot create usage, a charge, credit, invoice, subscription, or payment fact.

## AssureGraph

AssureGraph binds programs, subjects, risks, controls, mappings, evidence requests and attachments, human control tests, remediations, exceptions, and private audit packs. External evidence is stored as an exact tenant-owned reference and snapshot hash, not copied source data. Gap analysis remains a cited proposal.

## LiveForum

LiveForum records sessions, short-lived presenter and attendee grants, media-consent receipts, broadcast receipts, chat, human moderation, prompts, responses, and replay proposals. No media server is embedded in the domain engine. Broadcast, access, consent, and moderation state changes require their exact human receipts and never arise from model output.

## Identity, capability, and receipt boundaries

- People employee and manager references, onboarding owners, review assignees, and LiveForum attendees must resolve to authenticated members of the same workspace with `member` role or higher. LiveForum presenter grants require an `admin` or owner because every presenter capability invokes an admin-only broadcast, prompt, moderation, or end action. Viewer-only identities, ordinary members receiving unusable presenter grants, missing members, and cross-tenant identities are rejected before preview or persistence.
- Subject-originated receipt IDs are deduplicated inside the subject boundary when the upstream receipt namespace is not provider-global. Policy acknowledgements and leave requests use `(subjectUserId, subjectReceiptId)`, attendance uses `(subjectUserId, sourceReceiptId)`, and media consent uses `(participantRef, subjectReceiptId)`. Reusing the receipt for the same subject fails, while another subject's independent receipt namespace is not treated as proof for, or a duplicate of, the first subject.
- Provider, employment-decision, correction, review-submission, and other receipt identifiers retain the broader uniqueness boundary declared by their action. Subject scoping does not weaken provider receipt uniqueness or actor-bound command idempotency.

## Trusted external-evidence boundary

The domain engine never treats caller-supplied provider IDs, source attestations, timestamps, scanner IDs, or account references as verified facts by themselves. The hosting layer must supply a trusted `verifyExternalEvidence` adapter. For each external-evidence action, the engine creates a versioned request bound to the exact workspace, authenticated actor, module, action, request clock, normalized evidence payload, and canonical SHA-256 evidence hash. The hash covers the stable workspace/actor/action/evidence envelope; the independently validated request clock prevents an expired or future verification from being accepted. The adapter response is accepted only when it:

- explicitly reports `verified: true`;
- identifies a bounded verifier and unique verification event;
- returns the exact evidence hash; and
- has a valid verification clock that is not later than the action clock.

The verified adapter result is stored with the resulting receipt. This boundary applies to event payments, refunds and check-ins; People access revocations; metering usage events; and metering invoice payments. The default adapter returns no verification, so these non-dry-run actions fail closed until a trusted hosting-layer adapter is configured. Dry-run output can describe the proposed boundary but never claims the external evidence was verified.

The shipped HTTP dispatcher, and therefore the CLI and MCP tools that call it, accepts an injected adapter. When `EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET` is configured, it installs the built-in hosting adapter. That adapter accepts only a short-lived `externalEvidenceToken` signed over the exact workspace, actor, module, action, evidence hash, verifier identity, verification identity, and validity window. Customers never receive the HMAC secret. A trusted provider webhook, scanner, usage collector, or access operator can import `signExtendedExternalEvidenceAttestation`, or a host operator can pipe the exact verified envelope into the root-only `npm run attest:external-evidence` command inside the control-plane image. Changing any business field, actor, workspace, action, token signature, or validity clock fails closed before a domain record or command receipt is committed.

## Atomic offboarding boundary

Offboarding requires an active non-owner workspace member, an attributable human employment approval whose decision ID exactly matches the submitted employment receipt, and at least one trusted hosting-layer access-revocation receipt bound to the same profile and subject and effective by the offboarding clock. Future-effective offboarding is rejected rather than silently scheduled.

Profile closure, immutable offboarding receipt creation, and removal of the subject's workspace membership execute in the same `SuiteStore` workspace transaction. If membership removal fails, the transaction fails and the profile and receipt mutations roll back; the engine does not report a completed offboarding while leaving workspace access active.

## Effect and AI rules

- Each action declares its minimum role, risk, destructive status, external-effect class, idempotency, approval, dry-run behavior, and effect boundary.
- Approved ledger commands persist evidence but do not claim a provider call occurred. Provider execution requires a separate reviewed adapter, and external facts require the trusted hosting-layer evidence verification described above.
- Proposal actions select tenant-owned records explicitly. The AI claim path cannot broaden that selection to neighboring records or another workspace.
- The worker validates the versioned proposal-only result contract and rejects unselected citations, unknown result fields, asserted external effects, or autonomous mutation flags.
- Employment, financial, access, consent, moderation, publication, and broadcast decisions remain outside model authority.

## Review checklist

1. Preserve plan, role, scope, tenant, optimistic-version, and idempotency checks before mutation.
2. Preserve dry-run behavior and attributed approval for every consequential action.
3. Keep external-evidence actions fail-closed unless a trusted hosting-layer adapter verifies the exact canonical evidence hash and clock.
4. Preserve subject-scoped receipt deduplication separately from provider-wide receipt uniqueness and actor-bound command idempotency.
5. Preserve People privacy checks inside trusted transactions and revoke non-owner workspace membership atomically with effective offboarding.
6. Keep proposal results strict, cited, review-pending, and incapable of dispatching another action.
7. Keep CLI, MCP, HTTP, and direct tests on the same registry and `SuiteStore` dispatcher path.
