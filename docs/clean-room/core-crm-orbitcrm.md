# OrbitCRM clean-room product specification

## Product boundary

OrbitCRM is a first-party MIT relationship graph and opportunity ledger. It derives from CRM business requirements rather than another CRM's implementation, database, endpoints, screens, or brand.

## Why it is better and AI-native

- External-key reconciliation is exact; fuzzy matches never silently merge people or companies.
- Opportunity amounts use integer minor units and uppercase ISO currencies.
- Pipeline transitions are explicit state edges with optimistic versions and append-only events.
- Forecasting is deterministic and inspectable from user-supplied stage probabilities.
- AI duplicate review and next-action proposals cite selected evidence, expose uncertainty and model/prompt provenance, and cannot merge or contact anyone.

## Domain model and invariants

`account` owns an external key and domain. `contact` records account link, normalized email, and consent basis. `opportunity` owns amount minor, currency, close hypothesis, stage, and version. `activity` and `opportunity-event` are immutable history.

External keys cannot be reused for different account data. Contacts require a tenant-owned account. Allowed transitions are qualified to evaluation/lost, evaluation to proposal/lost, and proposal to won/lost. Forecasts never combine currencies.

## CLI and MCP surface

Actions: `account-upsert`, `contact-link`, `opportunity-open`, `opportunity-transition`, `activity-record`, `duplicate-review-propose`, `next-action-propose`, `pipeline-forecast`, and `crm-export`. MCP names use `crm_`; every mutation is idempotent.

## Threat model

- Wrong-person merge: AI may propose matches but there is no autonomous merge action.
- Protected-trait inference: the model policy forbids inference of protected traits, personality, or buying intent.
- Currency/rounding errors: amounts are safe integers; deterministic forecasts round each weighted opportunity to minor units.
- Stale writes: opportunity transitions require exact expected version.
- Tenant leakage: every dereference uses workspace ownership; database integration must enforce workspace RLS and unique idempotency receipts.

## Import and export

The clean-room slice exports a canonical account graph. A future import must be preview-first, external-key explicit, and conflict-preserving. Secrets and enrichment-provider tokens remain outside core records.

## License and provenance

OrbitCRM is MIT-licensed first-party work. No third-party CRM source, migrations, API descriptions, UI assets, or trade dress were reused.
