# Paid plan quota and physical placement contract

The hosted plans sell a complete logical usage envelope. They do not sell idle,
dedicated RAM, CPU, or disk on one worker. Every paid installation persists the
exact configured limits that were sold:

- Starter: the exact CPU, memory, storage, and service limit in `PLAN_CATALOG_JSON`.
- Scale: the exact CPU, memory, storage, and service limit in `PLAN_CATALOG_JSON`.
- Fleet: the exact CPU, memory, storage, and service limit in `PLAN_CATALOG_JSON`.

Plan IDs and sizes remain data-driven. A later configuration edit cannot
silently shrink or expand an existing customer's quota. Shared first-party
Suite modules use the control-plane database, so a Suite-only customer consumes
zero per-customer worker application capacity. This is one multi-tenant
PostgreSQL data plane with forced workspace row-level security, not one database
server per customer. Enabled modules in a workspace share records, links,
events, and allowlisted AI evidence; upstream catalogue applications retain
their own databases and volumes.

The checked-in hosted defaults are:

| Plan | Price | Infrastructure allocation | Platform fee | Suite access | Application quota |
| --- | ---: | ---: | ---: | --- | --- |
| Starter | $7/month | $5.00 | $2.00 | 23 Starter modules | 1.5 GB memory, 0.5 vCPU, 10 GB storage, 2 services |
| Scale | $50/month | $44.64 | $5.36 | 32 modules, including Projects, Drive, Channels, meetings, insights, learning, community, events, and people | 6 GB memory, 2 vCPU, 100 GB storage, 12 services |
| Fleet | $200/month | $178.57 | $21.43 | all 37 modules, including Operations, Assistant, metering, assurance, and live | 24 GB memory, 8 vCPU, 500 GB storage, 50 services |

The suite count is derived from the current 37-module registry. These are
pooled logical quotas, not dedicated-VM promises. A private self-host can use
`SUITE_ENTITLEMENT_MODE=unrestricted` and does not need Stripe to unlock the MIT
suite.

Migration 007 creates the constrained quota ledger without inventing allocations
for existing subscriptions. The migration command then runs a serialized,
idempotent legacy backfill under the same advisory lock as checkout. It refuses
active checkout or plan-change holds and grants a quota only when subscription
ownership, the stored infrastructure/platform price split, the configured plan,
application reservations, and one unambiguous live worker placement all match.
Any mismatch rolls back the whole batch before affinity or allocation writes.

## No double counting

`installation_capacity_allocations` is the logical quota ledger. Immutable
`application_instances` reservations are the physical worker commitments.
Worker placement sums assigned application reservations plus active checkout
item holds. It never counts a logical plan envelope or plan-change delta as
physical usage, and it never adds an application twice.

The worker independently reconciles the complete assigned application list
against its recorded memory, CPU, and storage totals before any Compose start.
Every service, including ingress proxies and database/cache auxiliaries, has an
explicit Docker memory and CPU limit whose manifest sum matches the database
reservation. The worker also compares advertised capacity with physical RAM,
logical CPU, filesystem size, free reserved disk headroom, and measured
workspace bytes.

The default ext4 bind-mount backend is `measurement-only`. It can detect an
overrun, stop the whole application Compose project, exclude the route, and
write `.managed-storage-quarantine.json`; it cannot stop writes at the exact
byte boundary between scans and never auto-clears the marker. Backup, stop, and
uninstall remain available for recovery. Live billing is fail-closed until an
operator provisions a real project-quota backend, installs a reviewed helper,
proves each exact workspace path and byte limit, and records the Terraform
proof acknowledgement. The repository does not claim hard storage isolation
from ordinary ext4 bind mounts.

Initial checkout persists the complete logical snapshot in
`checkout_plan_capacity_holds`, while `checkout_capacity_hold_items` reserve
only the exact applications selected today. Stripe checkout creation is
forbidden unless every selected application fits both the target plan quota and
the current worker pool. A Suite-only checkout may have no item holds. The paid
webhook atomically turns an active logical snapshot into a durable quota,
converts item holds to fixed application placements, records the subscription,
queues the exact install jobs, and consumes the hold. Delayed delivery after
expiry follows the recover-or-compensate contract below instead of rejecting a
valid signed payment solely because the temporary reservation elapsed.

## Clone placement

Clone creation takes the same global placement lock as checkout. In one
database transaction it locks the installation and quota, checks service,
memory, CPU, storage, and safety-reserve limits, locks recently healthy workers,
places the exact new application reservation, appends the installation's
`app_ids`, creates the worker-bound install job when the installation is live,
and stores the idempotency receipt. The API requires an `Idempotency-Key`; a
concurrent exact replay returns the same application and job, while reuse for a
different request fails closed. If either the logical quota or physical pool
cannot fit the request, every mutation rolls back. The capacity preview used by
the API is advisory; this transaction is the authoritative
fail-before-mutation boundary.

## Resize lifecycle

An upgrade first creates `plan_capacity_change_holds` while the current logical
allocation is locked. The hold records the positive logical quota delta, target
envelope, generation, price, owner, subscription, and idempotency key. It is not
physical worker usage. Stripe is called only after this transaction commits. A
successful Stripe response consumes the same hold and changes the quota plus
installation plan and locally stored prices in one database transaction. The
Stripe update metadata carries the owner, installation, target plan, and exact
`capacityChangeHoldId`. Therefore a successful provider update whose response
is lost can be completed by the signed subscription webhook or scheduled
reconciler. An expired hold may converge to consumed only when one of those
trusted paths supplies an exact provider confirmation; the original expiry is
preserved for audit. An exact provider-old retrieval releases a failed update,
while an ambiguous provider result leaves the hold intact for reconciliation.
Provider-new/local-old is never treated as an ordinary price mismatch and is
not quarantined before this convergence attempt. Expiration and retries are
idempotent.

A downgrade uses the same lifecycle. It is rejected unless current application
usage fits the smaller target. The logical quota shrinks only when Stripe and
the database commit the same change. Existing physical application reservations
do not change merely because unused quota was removed.

## Cancellation and recovery

An inactive subscription suspends customer routing and paid mutations. Its
logical allocation becomes `suspended`, and every assigned application remains
counted physically until an explicit worker cleanup removes that assignment.
Reactivation changes the same quota back to active; it cannot create duplicate
physical usage. Repeated webhooks and reconciliation runs converge on one state
transition and one generation event. A future retention-aware release workflow
must prove worker cleanup and an explicit storage decision before moving a
logical allocation to `released`.

A signed checkout that arrives after its temporary hold gets one atomic fresh
placement attempt. If current capacity is unavailable, it remains
non-entitled as `paid_pending_capacity` and is retried by the scheduled
reconciler. At the configured deadline, the durable action becomes provider
subscription cancellation plus a captured-payment refund. The local
`compensated` transition is permitted only after the apply-mode Stripe worker
has verified the exact subscription cancellation and complete initial-invoice
refund and supplies their durable provider references. The repository does not
make or simulate a refund call, and pending or failed refunds never become a
local compensation success.

The hosted rollout remains fail-closed while billing or provisioning is
disabled. These tables do not enable either switch. As verified on 2026-08-24,
the public preview reported `mode: "dry-run"` and `billingReady: false`; the
prices above are configured offers, not evidence that checkout or provisioning
is currently available on the hosted site.
