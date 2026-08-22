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
- Terraform for an IAP-protected control plane and a horizontally scalable pool of private Google Compute Engine workers.
- Transactional Stripe checkout and signed, replay-safe webhook handling that queues provisioning only after payment.
- Authenticated remote Docker agents for install, start, stop, update, routing, encrypted backup, and restore jobs. Workers never receive PostgreSQL or Stripe credentials.
- Capacity-aware per-application placement, renewable job leases, and per-worker CPU, memory, and storage reservations.
- DNS verification, CNAME targets, a central dynamic Caddy gateway, private worker ingress, and automatic TLS after ownership resolves.
- Dry-run safety: checkout and provider mutations fail closed independently until their production gates pass.

The managed service uses PostgreSQL. Local development without `DATABASE_URL` deliberately uses temporary in-memory accounts.

## Catalogue status

| Product category | Upstream project | Pinned version | Licence | Status |
| --- | --- | --- | --- | --- |
| Calendly-style scheduling | [Cal DIY](https://github.com/calcom/cal.diy) | v6.2.0 | AGPL-3.0 | Verified core runtime; customer SMTP/calendar OAuth required |
| Mailchimp-style newsletters | [listmonk](https://github.com/knadh/listmonk) | v6.2.0 | AGPL-3.0 | Planning enabled |
| DocuSign-style signatures | [Documenso](https://github.com/documenso/documenso) | v2.17.0 | AGPL-3.0 | Verified core runtime and persistent signing certificate; customer SMTP required |
| Jotform-style forms | [HeyForm](https://github.com/heyform/heyform) | v3.0.1 | AGPL-3.0 | Verified runtime with managed MongoDB, KeyDB, and uploads; unavailable social-login providers are hidden |
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
WORKER_BOOTSTRAP_TOKEN=          # Secret Manager value used only for agent enrolment
GATEWAY_RECONCILER_TOKEN=        # Secret Manager value used only for route discovery
```

Machine prices are configuration, not application constants. Set them from the current provider quote for the selected project and region.

The hosted defaults expose three pooled-capacity plans. They are customer quotas backed by the private worker fleet, not dedicated VM promises:

| Plan | Monthly total | Memory quota | CPU quota | Storage quota | Service instances |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | $7 | 1.5 GB | 0.5 vCPU | 10 GB | 2 |
| Scale | $50 | 6 GB | 2 vCPU | 100 GB | 12 |
| Fleet | $200 | 24 GB | 8 vCPU | 500 GB | 50 |

The total contains an itemized infrastructure allocation plus the configured management fee. A user can clone the same verified service multiple times; every clone receives a separate hostname, container project, volume reservation, and placement decision. Upgrades reconcile the existing Stripe subscription before the stored quota changes.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

The tests cover price/capacity policy, secure account flows, cross-account isolation, domain changes, fail-closed billing, authenticated node enrolment, capacity-aware placement, tenant affinity, and private gateway routes.

## Scale model

The public `e2-medium` is the control plane, not the place customer tools run. It owns accounts, scheduling, billing state, PostgreSQL, and edge TLS. Customer containers and persistent volumes run on private workers with no public IP. A worker is added when its advertised reservations no longer fit another application. Individual applications keep worker affinity for lifecycle and restore operations, while larger customer workspaces may span several workers behind the same edge gateway.

`worker_count` is deliberately explicit in Terraform. The scheduler will refuse an install that does not fit, rather than overcommit a node. Automated instance creation and removal remains locked until drain, restore, quota, cost, and failed-payment reconciliation have production proofs.

## Remaining live-provisioning gates

The current release is a safe control-plane MVP, not a production hosting marketplace. Before `PROVISIONING_MODE=live`:

1. Publish and digest-pin every application image and its dependencies.
2. Pass install, health, upgrade, rollback, encrypted backup, and restore tests per application.
3. Complete destructive lifecycle and failed-payment/cancellation reconciliation tests.
4. Prove tenant isolation, worker drain/migration, resource limits, secret rotation, outbound-email abuse controls, and incident recovery.
5. Confirm the exact Google Cloud account, project, region, quota, and recurring price before creating customer resources.

## License

Managed OSS Cloud is MIT licensed. Catalogue applications retain their own upstream licenses.
