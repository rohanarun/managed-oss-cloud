# First-party growth products: clean-room and MIT record

This folder specifies three original products implemented for this repository:

- **FairLaunch**: consent-aware giveaways and referral contests.
- **ProofPort**: testimonial collection, review, publication versions, and widgets.
- **BeaconPage**: branded pages, dynamic QR routes, and privacy-conscious aggregate measurement.

The implementation is repository-native TypeScript and is intended to be released under the repository's MIT license. It does not import, translate, decompile, or copy source code, assets, documentation, schemas, tests, trade dress, or private behavior from a commercial product. Product-category names in the user brief were treated only as statements of desired outcomes. The architecture was derived from the existing `SuiteStore` contract, the shared customer database, public web safety requirements, and independently authored product invariants.

## Inputs used

- User-supplied functional requirements: contests, referrals, testimonial widgets, branded QR codes, link-in-bio pages, CLI tools, MCP tools, and AI-native workflows.
- Existing first-party interfaces in this repository: `SuiteStore`, `SuiteRecord`, `SuiteAiAction`, workspace roles, modules, quotas, and public-host boundaries.
- General engineering knowledge: JSON Schema, SHA-256 commitments, rejection sampling, idempotency receipts, immutable versions, consent revocation, content-addressed publication, and aggregate analytics.

No third-party source repository was consulted or incorporated for these modules. Names, prompts, action IDs, data shapes, algorithms, tests, and documentation in this folder were authored for this codebase.

## Independence rules

1. Preserve capabilities, not another product's expression or interface.
2. Use the repository's design language and shared database instead of reproducing another application's database, endpoints, command names, or UI.
3. Store exact evidence and human decisions; never fabricate model results, consent, review, publication, fraud, or delivery state.
4. Keep all model actions proposal-only and require evidence citations plus human review.
5. Do not add a dependency whose license is incompatible with MIT distribution.
6. Before release, run the repository license audit and retain its output with release evidence.

## Code boundaries

- Action contracts: `src/shared/first-party-growth-actions.ts`
- Persistent execution engine: `src/server/first-party-growth-engine.ts`
- Model boundaries: `src/server/prompts/first-party-growth.ts`
- Verification: `tests/first-party-growth-engine.test.ts`

The engine stores all business state, consent records, AI audit records, and idempotency receipts through `SuiteStore`. It does not use a module-level `Map`, transient process lock, fabricated provider receipt, or autonomous external executor.

## Release checklist

- Verify every module exposes at least eight uniquely named, strict-schema actions.
- Verify CLI examples and MCP names are generated from the same action catalogue.
- Run focused tests and the repository's full type, build, test, MCP, and license checks.
- Review public product names and marks before marketing; the clean-room implementation does not grant trademark rights.
- Publish source under the repository MIT license and preserve this record in tagged release source.
