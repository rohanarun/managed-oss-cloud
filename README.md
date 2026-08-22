# Managed OSS Cloud

Managed OSS Cloud is an MIT-licensed control plane for running open-source business software through one account, one dashboard, and custom domains. It supports a managed service and a self-hosted Google Cloud path.

[Managed service](https://cloud.getsupers.com) · [Google Cloud guide](docs/google-cloud.md)

## What works

- Public product site with an audited application catalogue.
- Signup, login, logout, salted `scrypt` password hashes, HTTP-only session cookies, rate limits, and same-origin mutation checks.
- PostgreSQL repositories for durable users, sessions, per-user server plans, domains, subscriptions, billing ledger entries, and idempotency records.
- Account-isolated dashboard for catalogue selection, server capacity, custom-domain CNAME instructions, and upgrade planning.
- Configurable machine prices and a separately itemized percentage/minimum management fee.
- Capacity checks that retain a memory safety reserve and split incompatible workloads.
- Terraform for an IAP-protected Google Compute Engine host.
- Transactional Stripe checkout and signed, replay-safe webhook handling that queues provisioning only after payment.
- A PostgreSQL-backed Docker worker for install, start, stop, update, routing, encrypted backup, and restore jobs.
- DNS verification, CNAME targets, dynamic Caddy routes, and automatic TLS after ownership resolves.
- Dry-run safety: checkout and provider mutations fail closed independently until their production gates pass.

The managed service uses PostgreSQL. Local development without `DATABASE_URL` deliberately uses temporary in-memory accounts.

## Catalogue status

| Product category | Upstream project | Pinned version | Licence | Status |
| --- | --- | --- | --- | --- |
| Calendly-style scheduling | [Cal DIY](https://github.com/calcom/cal.diy) | v6.2.0 | MIT | Integration verification |
| Mailchimp-style newsletters | [listmonk](https://github.com/knadh/listmonk) | v6.2.0 | AGPL-3.0 | Planning enabled |
| DocuSign-style signatures | [Documenso](https://github.com/documenso/documenso) | v2.17.0 | AGPL-3.0 | Integration verification |
| Jotform-style forms | [HeyForm](https://github.com/heyform/heyform) | v3.0.1 | AGPL-3.0 | Integration verification |
| Uptime monitoring | [Uptime Kuma](https://github.com/louislam/uptime-kuma) | 2.3.2 | MIT | Planning enabled |
| Web analytics | [Umami](https://github.com/umami-software/umami) | v3.3.1 | MIT | Planning enabled |

Managed OSS Cloud packages and operates upstream software; it does not impersonate the commercial products those projects can replace. Every application retains its upstream licence, trademarks, and update policy.

## Local development

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. Without `DATABASE_URL`, the app clearly reports `preview-memory` persistence.

## Production environment

```text
DATABASE_URL=postgresql://...
DATABASE_SSL=true
PUBLIC_APP_URL=https://control.example.com
PUBLIC_HOST_TARGET=apps.example.com
PROVISIONING_MODE=dry-run
PLAN_CATALOG_JSON={...}
PLATFORM_FEE_PERCENT=12
PLATFORM_FEE_MIN_CENTS=200
STRIPE_PUBLISHABLE_KEY=          # browser-visible publishable key
STRIPE_SECRET_KEY=               # load from Secret Manager, never Git
STRIPE_WEBHOOK_SECRET=           # load from Secret Manager, never Git
BILLING_MODE=disabled            # switch independently after live webhook proof
PROVISIONING_WORKER=disabled     # switch independently after worker proof
BACKUP_BUCKET=                   # private GCS bucket
BACKUP_KEY_HEX=                  # 32-byte key from Secret Manager
```

Machine prices are configuration, not application constants. Set them from the current provider quote for the selected project and region.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

The tests cover price/capacity policy, provider requests, secure account flows, cross-account isolation, domain changes, upgrade planning, and fail-closed billing.

## Remaining live-provisioning gates

The current release is a safe control-plane MVP, not a production hosting marketplace. Before `PROVISIONING_MODE=live`:

1. Publish and digest-pin every application image and its dependencies.
2. Pass install, health, upgrade, rollback, encrypted backup, and restore tests per application.
3. Complete destructive lifecycle and failed-payment/cancellation reconciliation tests.
4. Prove tenant isolation, resource limits, secret rotation, outbound-email abuse controls, and incident recovery.
5. Confirm the exact Google Cloud account, project, region, quota, and recurring price before creating customer resources.

## License

Managed OSS Cloud is MIT licensed. Catalogue applications retain their own upstream licenses.
