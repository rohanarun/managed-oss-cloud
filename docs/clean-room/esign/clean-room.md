# E-signature workflow clean-room and MIT record

## Scope

This slice is an independently authored, repository-native implementation of a basic electronic document approval workflow. Public category references such as DocuSign, BreezeDoc, and Documenso were used only to identify the broad customer problem. No code, UI, assets, copy, schemas, tests, API compatibility layer, trade dress, private behavior, or branding was copied from those products.

The implementation is intended to ship under this repository's MIT license. That software license does not grant rights to third-party trademarks, certify regulatory compliance, or decide whether an electronic record is enforceable in a particular jurisdiction.

## Independently derived requirements

The design was derived from these repository-native constraints:

- one tenant-isolated `SuiteStore` database shared with the customer's other enabled modules;
- exact content, object-version, template-version, envelope-version, and signer-session boundaries;
- caller-provided idempotency keys and durable command receipts;
- human approval and dry-run gates for dispatch planning, token issuance, field-completion facts, declines, voids, reminders, and exports;
- local or workspace-configured AI that returns cited proposals only;
- no provider call, delivery claim, signature generation, consent inference, or hidden external effect;
- no plaintext signer token or raw field value in durable records; and
- narrow claims limited to basic workflow facts.

## Source boundary

The new isolated implementation consists of:

- `src/shared/esign-actions.ts`
- `src/server/esign-engine.ts`
- `src/server/prompts/esign.ts`
- `tests/esign-engine.test.ts`
- `docs/clean-room/esign/*`

No third-party e-signature package is imported or bundled. Document bytes remain in customer-selected object storage; this module records only an opaque object reference, exact object version, byte count, media type, page count, and SHA-256.

## Naming and release review

“E-Signature Workflow” is a descriptive provisional product label, not a reviewed trademark. Before public marketing, perform a name and trademark review, dependency/license audit, and legal review of customer-facing claims. Do not market the certificate manifest as an advanced or qualified signature, a compliance certificate, identity proof, legal advice, or an enforceability guarantee.
