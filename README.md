# Managed OSS Cloud

Managed OSS Cloud is an open-source control plane for running business software through one dashboard and custom domains. It supports a managed one-click service and a self-hosted Google Cloud path.

The current MVP provides:

- a catalogue of open-source alternatives;
- a capacity planner that packs compatible lightweight apps into one customer server;
- an automatic split recommendation for heavy or incompatible apps;
- configurable Render plan prices and platform fees;
- dry-run server creation, server inventory, custom-domain CNAME instructions, and plan upgrades;
- a typed Render API client for image-backed services, custom domains, plan changes, and deploys;
- a Google Cloud Terraform module for a free-tier-eligible Docker host with stable DNS;
- a production database schema for users, billing, installations, domains, and idempotency.

## Product paths

### Managed

Customers choose applications, connect a custom domain, and pay the infrastructure share plus a transparent management fee. Lightweight applications can share pooled compute; capacity-heavy or higher-isolation applications move to a larger or dedicated service.

### Self-hosted

Customers deploy the same stack into their own Google Cloud project. The software is free and MIT licensed; Google bills any infrastructure outside the account's eligible allowances. See [the Google Cloud guide](docs/google-cloud.md).

The catalogue can grow without a software licence limit. A server still has finite CPU, memory, and storage, so the capacity planner prevents unsafe combinations and recommends an upgrade.

## Important deployment boundary

Render exposes one public HTTP port per web service and recommends separate services for application isolation. The shared-server model therefore requires a purpose-built appliance image containing the supported app processes and reverse proxy. Arbitrary Docker Compose stacks cannot be installed dynamically inside a normal Render service.

The control plane defaults to `PROVISIONING_MODE=dry-run`. It must remain in dry-run until the appliance images, persistent database repository, authentication, Stripe payment flow, and app-specific backup/upgrade checks are connected.

## Local development

```sh
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

## Pricing

Render plan prices are supplied through `RENDER_PLAN_CATALOG_JSON`. The management fee is configured with `PLATFORM_FEE_PERCENT` and `PLATFORM_FEE_MIN_CENTS`. This keeps billing policy out of application logic and makes price changes auditable.

## Live provisioning checklist

1. Pin and audit each catalogue app version and license.
2. Build and publish signed appliance images for bundle-compatible combinations.
3. Replace the development installation store with the PostgreSQL schema in `db/schema.sql`.
4. Add account authentication and session enforcement.
5. Connect Stripe Checkout, metered invoice items, and verified webhooks.
6. Require a valid payment method and idempotency key before every paid Render mutation.
7. Set `PROVISIONING_MODE=live` only after an end-to-end test workspace succeeds.

## License

MIT. Catalogue applications retain their own upstream licenses.
