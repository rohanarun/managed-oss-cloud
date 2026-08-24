# Premium business suite licensing record

## First-party license

The original premium business suite source and documentation introduced in these files is intended for release under the repository's MIT License:

- `src/shared/premium-business-actions.ts`
- `src/server/premium-business-engine.ts`
- `src/server/premium-business-store-engine.ts`
- `src/server/prompts/premium-business.ts`
- `tests/premium-business-engine.test.ts`
- `tests/premium-business-store-engine.test.ts`
- `docs/clean-room/premium-clean-room.md`
- `docs/clean-room/premium-product-spec.md`
- `docs/clean-room/premium-threat-model.md`
- `docs/clean-room/premium-license.md`
- `docs/clean-room/premium-store-integration.md`

Copyright follows the owner and year declared by the root `LICENSE` file. This record does not replace that license text; it identifies the first-party provenance and intended coverage of this slice.

## No upstream code incorporation

The slice contains no source code, assets, UI, database schema, API compatibility implementation, tests, documentation prose, or bundled component from Plane, Nextcloud, Zulip, ERPNext, LibreChat, or another category product. Their names should not appear in product-facing branding. Category references may remain only in internal clean-room review records or a factual comparison written by counsel or product leadership.

## Runtime dependencies

The engine uses only Node.js built-in cryptography plus first-party TypeScript in this repository. The tests use the repository's existing Vitest development dependency. No new runtime dependency, copied model, font, icon, binary, container image, or dataset is introduced by this slice.

## Models and connectors

The MIT License for the control plane does not automatically license a model, dataset, hosted inference service, object store, communication provider, accounting connector, or customer content. A later connector must preserve its own license and terms metadata. A model can be presented as bundled or redistributable only after verifying its exact weights license, tokenizer license, acceptable-use terms, attribution, and redistribution requirements for the shipped version.

## Trademark boundary

Northstar Planning, Harbor Vault, Threadline, Ledgerline Operations, and Evident AI Workbench are the first-party working names in this implementation. Do not use another vendor's name, logo, screenshots, trade dress, or claims of affiliation. Do not describe the products as official, compatible, drop-in, or cloned without a separately reviewed factual basis.

## Contribution attestation

Contributors to this slice should attest that their change is original or properly MIT-compatible, identify every new dependency or generated asset, and confirm that they did not copy from an upstream category product. License scanning and source-provenance checks should remain required in CI before a public release.
