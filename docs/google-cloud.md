# Self-host on Google Cloud

This path creates a dedicated control-plane VM plus an optional pool of private application workers. The same architecture powers the hosted service; a self-hosting customer keeps the Google Cloud project and billing authority.

## Cost boundary

The control plane and every worker are separate billable resources. The included Terraform reserves one external IPv4 for stable customer DNS; workers use private IPs and shared Cloud NAT for outbound image pulls and updates. Persistent disks, traffic, NAT, backups, and each worker VM are additional costs. Do not price the hosted product as if one free-tier micro VM can serve hundreds of customer applications.

Both control-plane and worker instances have Compute Engine deletion protection enabled, and their boot disks have auto-delete disabled. These safeguards prevent an ordinary instance deletion from silently removing state, but retained disks remain billable and are not backups. Recovery and deliberate disk retirement still require verified off-instance backups and a separately reviewed procedure.

## Prerequisites

- a Google Cloud account with billing enabled;
- `gcloud` authenticated to the target account;
- Terraform 1.6 or newer;
- permission to create Compute Engine instances, addresses, and firewall rules.

## Deploy

```sh
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable compute.googleapis.com iap.googleapis.com

cp infra/google-cloud/terraform.tfvars.example infra/google-cloud/terraform.tfvars
terraform -chdir=infra/google-cloud init
terraform -chdir=infra/google-cloud plan
terraform -chdir=infra/google-cloud apply
```

Terraform prints the static IPv4, dashboard URL, control-plane SSH command, private worker addresses, and the configured capacity envelope. The control plane runs PostgreSQL, the API, and the edge Caddy gateway. Each worker runs only its authenticated agent, a private Caddy listener, and assigned tenant containers. Keep `PROVISIONING_MODE=dry-run` and `BILLING_MODE=disabled` until the live-provisioning gates in the README pass. A worker may be registered in dry-run to prove private networking and heartbeats; job leasing remains locked.

The public preview was still in that locked state when checked on 2026-08-24: health reported PostgreSQL with `mode: "dry-run"`, and config reported `billingReady: false`. The checked-in source is ahead of that deployment. Do not use the existence of the VM, DNS, a worker heartbeat, or a green health endpoint as evidence that checkout, customer installation, the 37-module suite, or hosted signing has been deployed.

Terraform rejects `billing_mode="live"` unless all three production prerequisites are declared in the same reviewed plan: `provisioning_mode="live"`, `worker_count >= 1`, and `subscription_reconciliation_mode="apply"`. This prevents the hosted control plane from opening Stripe checkout while installs are simulated, no worker exists, or missed/cancelled subscriptions cannot be reconciled. Run the documented one-shot reconciliation command in read-only mode and review its report before preparing that plan; Terraform deliberately has no partially live checkout stage.

Startup is fail-closed. Before any control-plane Compose command, the trusted host reads its pinned Secret Manager versions, installs persistent IPv4 and IPv6 `DOCKER-USER` metadata rejection rules, verifies host metadata still works, and proves a real bridge container cannot reach either metadata address. The control-plane marker is removed first and recreated only when that machine-readable firewall proof is present, the migration job succeeds, PostgreSQL and the control-plane container are healthy, `/api/health` reports PostgreSQL persistence and the configured provisioning mode, and Caddy plus the route reconciler are running. Every worker performs the same host-metadata/bridge-container proof against its exact provenance-verified image before its first Compose pull. Its marker is recreated only when that proof is present, its containers run, the control plane is healthy, the agent token exists, and the control-plane activity API proves a fresh heartbeat from that exact node ID and private address. A missing marker is a failed deployment, not an eventually healthy one; inspect the serial console and Compose logs before retrying.

Set `control_plane_domain` and `apps_domain` in `terraform.tfvars` before production DNS. `control_plane_image` is required and accepts only an immutable GHCR `@sha256:` reference; use the digest published by the verified GitHub Actions build. Stripe, OAuth, signing, external-evidence, worker, gateway, session, and backup secrets belong in Google Secret Manager. Pin every corresponding `*_secret_version` input to a reviewed numeric version so a restart cannot silently consume a newly created `latest` value.

### Hosting-layer Google OAuth

Customers do not create Google OAuth clients. One platform-owned Google web client has exactly one authorized redirect URI: `https://CONTROL_PLANE_DOMAIN/oauth/google/callback`. The derived HeyForm image sends its existing browser state to `https://CONTROL_PLANE_DOMAIN/oauth/google/start`; the control plane authorizes the exact live HeyForm application route, persists a hashed one-time flow, signs a ten-minute opaque state, and uses PKCE. Only the control plane exchanges Google's authorization code and reads the verified Google profile. It returns a no-store, no-referrer, CSP-restricted auto-submit form that POSTs a 90-second Ed25519 assertion to the exact tenant callback. The assertion never appears in a URL, its audience is the exact tenant origin, and its state hash is checked against the HeyForm browser state before HeyForm creates or logs in a user.

Generate a distinct Ed25519 assertion key pair. Store only the base64 PKCS#8 private DER value in the Secret Manager secret selected by `google_oauth_assertion_signing_secret_name`; set the matching non-secret base64 SPKI public DER value as `google_oauth_assertion_public_key`:

```sh
openssl genpkey -algorithm ED25519 -out oauth-assertion-private.pem
openssl pkcs8 -topk8 -nocrypt -in oauth-assertion-private.pem -outform DER | base64
openssl pkey -in oauth-assertion-private.pem -pubout -outform DER | base64
```

The private OAuth variables are written to root-only `oauth.env`, which is mounted only into the control-plane service. Worker administration, consent signing, and the dedicated external-evidence HMAC value are isolated in `control-plane.env`; the gateway credential is isolated in `gateway.env`. Migration, reconciliation, AI, local-AI, worker, and tenant services receive neither the external-evidence key nor the OAuth secrets. Workers receive only `GOOGLE_OAUTH_BROKER_START_URL` and `GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY`; tenant HeyForm containers additionally receive their own public application ID. They never receive the Google client secret, platform state secret, provider authorization code, provider access token, assertion private key, or external-evidence attestation secret. Migration `012-managed-oauth-broker` provides the durable single-use flow ledger. For consent-policy signing-key rotation, populate the validated public-only `consent_policy_previous_public_keys` Terraform list during the overlap period; it is JSON-encoded only into `control-plane.env`. An OAuth assertion-key rotation requires a reviewed overlap or coordinated managed-image/application recreation; never replace a public key independently of its private key.

The managed service must keep `SUITE_ENTITLEMENT_MODE=hosted`; new accounts then begin with no entitlement and plans are derived from active or trialing Stripe subscriptions. A private self-hosting deployment that intentionally provides every first-party module without hosted billing may set `SUITE_ENTITLEMENT_MODE=unrestricted`. Never use unrestricted mode for the public multi-customer service. Public consent receipts also require the Ed25519 signing key named by `consent_policy_signing_secret_name`; Terraform grants only the runtime service account access and injects the key at boot without writing it to Terraform state.

The checked-in `deploy/google-cloud` and `deploy/google-cloud/worker` files are the two runtime templates. `CONTROL_PLANE_IMAGE` must contain an immutable GHCR digest. Digest syntax is not sufficient for a live rollout: use the [control-plane image provenance gate](../deploy/google-cloud/provenance/README.md), which verifies the remote manifest bytes plus GitHub's attestation for the exact repository, publishing workflow, and reviewed source commit before any pull or recreation. The supported existing-host rollout is `sudo deploy/google-cloud/rollout-control-plane.sh --source-commit REVIEWED_40_HEX_COMMIT`; it also installs the persistent metadata firewall and requires a fresh bridge-container proof before the first Compose pull. Do not substitute raw Compose pull/up commands. Keep all generated environment and agent-token files mode `0600`; they must never be committed. PostgreSQL reads only `postgres.env`. Workers never receive the database URL, Stripe secrets, session secrets, gateway token, or private OAuth material.

### PostgreSQL workspace isolation

Migration `003-suite-rls-phase-a` creates passwordless `NOLOGIN` group roles and transaction-local workspace resolvers. Migration `006-database-role-and-rls-enforcement` completes the boundary: it installs workspace policies and enables and forces row-level security on suite workspaces, memberships, domains, enabled modules, records, events, AI actions, API tokens, record links, and global hostname claims. Later migrations add global exact-once indexes and atomic AI completion functions for typed engines.

Create separate login principals and passwords through the host's secret-management procedure, grant each login only its matching `managed_oss_runtime`, `managed_oss_ai`, or `managed_oss_migrator` group role, and keep owner roles `NOLOGIN`. Stage `DATABASE_RUNTIME_URL` for the control-plane SuiteStore, `DATABASE_AI_URL` for one AI worker profile, and `DATABASE_MIGRATOR_URL` only for the one-shot migration service. Set `DATABASE_MIGRATION_MODE=manual` in long-running services. Do not place login passwords in a migration, Compose file, image, Terraform state, or repository.

The proposal-audit migration requires PostgreSQL's trusted `pgcrypto` extension for SHA-256 evidence revalidation. The checked-in Google Cloud rollout installs it idempotently with the database administrator immediately before running the separately scoped migrator. Immediately before migrations, that rollout also runs `preflight-migration-018-domain-identities.sql` through the same root-owned administrator password path. The preflight uses one repeatable-read, read-only transaction, rolls it back, and emits exactly the 24 invariant names with duplicate-group counts; it never returns customer identity values. A clean installation where `suite_records` does not exist yet returns those same names with zero counts. Any duplicate group, malformed report, timeout, or query failure stops rollout before the migration job. Duplicate evidence must be resolved through an independently reviewed, evidence-preserving process rather than deleted by deployment automation. Other deployment systems must install `pgcrypto` once with their database owner and perform an equivalent privacy-safe migration 018 duplicate preflight; the migration fails clearly rather than broadening the migrator role when the extension is absent.

Before rollout, test both allowed and forbidden queries using the real separated logins. Runtime and AI logins must be `NOSUPERUSER NOBYPASSRLS`, must not inherit an owner role, must see only the transaction-local `app.workspace_id`, and must not alter suite tables or migration state. A migration applying successfully as the owner is not tenant-isolation proof.

The suite uses one multi-tenant PostgreSQL data plane. Enabled modules inside one workspace share records, links, events, and allowlisted AI evidence; row-level security isolates different workspaces. Upstream catalogue applications are separate containers with their own databases and volumes.

Local model inference is deliberately absent from the default deployment. The explicit `local-ai` profile adds a multi-gigabyte Ollama image and Qwen3 4B model and should not be enabled on the default micro control-plane shape. Review the storage, memory, private-network, and startup requirements in [Optional local AI runtime](local-ai.md) before enabling it. The separate `ai` profile remains available for an approved hosted or separately managed OpenAI-compatible endpoint.

The hosted e-sign router is also absent from the default mount. Enabling it requires an exact signer origin, an exact-version object loader backed by a maintained PDF parser/sanitizer, a shared atomic rate limiter, credential/query log redaction, accessible explicit complete/decline controls, retention policy, and jurisdiction-specific legal review. The service records basic workflow facts only and must not be marketed as qualified or compliance-certified signing. See [Hosted signer security boundary](clean-room/esign/hosted-signer.md).

Letterline stops at a provider-neutral dispatch plan. Real email delivery requires a separately reviewed tenant-bound adapter and authenticated receipt gateway; provider credentials do not belong in the suite records or model context. See [Letterline database and adapter requirements](clean-room/email/database-requirements.md).

The backup bucket should enforce public-access prevention and uniform bucket-level access. Terraform gives each worker object create/view access only beneath that worker's object prefix and gives the control-plane runtime identity create/view access only beneath `control-plane/`. Control-plane PostgreSQL dumps use TLS in transit and Google Cloud Storage encryption at rest; the current lane does not add client-side encryption. Neither runtime identity receives delete permission. Control-plane PostgreSQL backups use a host-level lane with custom-format dumps, SHA-256 completion sidecars, and a non-destructive verification restore. The timer is off by default even when a bucket is configured. Enable `control_plane_backup_timer_enabled` only together with `control_plane_restore_proof_completed` after recording a successful first backup and isolated restore-verification drill; install and operate the lane from [Control-plane PostgreSQL backup and restore verification](../deploy/google-cloud/backup/README.md).

## Connect domains

Point the hosted wildcard to the printed edge IPv4, then let customers CNAME their domains to the application hostname shown in the dashboard:

```text
*.apps.example.com       A      203.0.113.10
calendar.customer.com    CNAME  cal-abcd.apps.example.com
```

The edge gateway verifies the custom domain, obtains TLS, and proxies over the private subnet to the assigned worker. Workers are never direct DNS targets.

## Capacity

The catalogue is not licence-limited. Running capacity is finite. The default `e2-medium` is only the control plane. Default application workers are private `e2-standard-2` nodes with 200 GB `pd-standard` disks, advertising 7,168 MB, 1,800 CPU-millis, and 180 GB of storage after explicit memory, CPU, and disk reserves. Before Compose starts, the agent reconciles control-plane reservations for all three dimensions against the assigned app set and physical host measurements. When no worker fits, the install remains queued and capacity must be added; the scheduler does not silently overload an existing node.

`WORKER_STORAGE_QUOTA_BACKEND=measurement-only` is the safe default for the current ext4 bind mounts. The agent measures allocated workspace blocks every minute. An observed overrun stops the entire application, removes its route, and writes a durable quarantine marker; measurement is not a hard write boundary. Do not enable live billing with this backend. Production billing requires an independently provisioned project-quota backend, an executable helper at `WORKER_STORAGE_QUOTA_HELPER`, successful `verify-host`, per-application `apply` and `verify` proofs for the exact path and byte limit, and `worker_storage_quota_proof_completed=true`. Terraform intentionally does not download or invent that privileged helper.

Paid quotas are pooled across the worker fleet. Starter is $7 monthly ($5 infrastructure + $2 fee) for 23 suite modules, 1.5 GB memory, 0.5 vCPU, 10 GB storage, and two service instances. Scale is $50 ($44.64 + $5.36) for 32 modules, 6 GB, 2 vCPU, 100 GB, and 12 instances. Fleet is $200 ($178.57 + $21.43) for all 37 modules, 24 GB, 8 vCPU, 500 GB, and 50 instances. These are quota envelopes rather than dedicated-machine claims. Suite-only customers reserve no per-customer application-container capacity. Each cloned upstream service gets its own storage reservation and can be placed on another worker while remaining in the same customer account.

Hundreds of customers therefore means a fleet, not one larger VM. The exact node count depends on the mix of applications, active usage, storage, and outbound email/traffic. Increase `worker_count` in a reviewed Terraform plan, or use the same worker registration API from a separately governed autoscaler after drain and cost controls are proven.

## Drain a worker agent

Before replacing an agent container, authenticate with the control-plane worker bootstrap credential and stop new leases:

```sh
curl -fsS -X POST "https://control.example.com/api/internal/workers/managed-oss-host-worker-0/mode" \
  -H "Authorization: Bearer ${WORKER_BOOTSTRAP_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"mode":"draining"}'

curl -fsS "https://control.example.com/api/internal/workers/managed-oss-host-worker-0/activity" \
  -H "Authorization: Bearer ${WORKER_BOOTSTRAP_TOKEN}"
```

Replace only the agent after `safeToReplaceAgent` is `true`. Before any worker-side pull or recreation, run the same provenance verifier against the exact `CONTROL_PLANE_IMAGE` in the worker's `worker.env`, the reviewed publishing commit, and a new immutable proof path. Pull that exact image directly, rerun `metadata-firewall-proof.sh`, and retain its new machine-readable proof for `worker-ready.sh`; a missing provenance or metadata proof forbids the Compose pull/recreation. Then recreate only the agent and reactivate the node through the same mode endpoint with `{"mode":"active"}`. Heartbeats never clear a drain. Healthy application traffic remains routed while the agent is draining. This is an agent-rollout guard, not volume migration: do not delete or replace the VM/disk until every assigned application has a separate verified backup or migration plan.

```sh
IMAGE="$(sudo awk -F= '$1 == "CONTROL_PLANE_IMAGE" { sub(/^[^=]*=/, ""); print }' /opt/managed-oss/config/worker.env)"
PROVENANCE_PROOF="/opt/managed-oss/provenance/worker-agent-$(date -u +%Y%m%dT%H%M%SZ).json"
METADATA_PROOF="/opt/managed-oss/security/worker-agent-$(date -u +%Y%m%dT%H%M%SZ).json"
READINESS_NOT_BEFORE="$(date +%s)"
sudo install -d -m 0750 /opt/managed-oss/provenance /opt/managed-oss/security
sudo deploy/google-cloud/provenance/verify-control-plane-image.sh \
  --image "$IMAGE" \
  --source-commit REVIEWED_40_HEX_COMMIT \
  --proof-file "$PROVENANCE_PROOF"
sudo docker pull "$IMAGE"
sudo env METADATA_FIREWALL_SCRIPT=/opt/managed-oss/security/metadata-firewall.sh \
  /opt/managed-oss/security/metadata-firewall-proof.sh "$IMAGE" \
  | sudo tee "$METADATA_PROOF" >/dev/null
sudo chmod 0640 "$METADATA_PROOF"
sudo jq -e '.ok == true and .hostMetadata == true and .bridgeIpv4Blocked == true and .bridgeIpv6Blocked == true' "$METADATA_PROOF" >/dev/null
sudo sh -c 'cd /opt/managed-oss/config && set -a && . ./worker.env && set +a && docker-compose pull agent && docker-compose up -d --no-deps agent'
sudo env WORKER_READINESS_NOT_BEFORE_EPOCH="$READINESS_NOT_BEFORE" \
  MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$METADATA_PROOF" \
  /opt/managed-oss/readiness/worker-ready.sh
```

## Security boundary

- Only control-plane ports 80 and 443 are opened publicly.
- Both edge and worker Caddy admin APIs bind only to `127.0.0.1:2019`; port 2019 is never published or exposed on a Docker bridge. The control-plane `gateway-reconciler` is the sole service that shares Caddy's network namespace and loads routes through that loopback endpoint. Worker tenant containers remain ordinary peers on the platform bridge and cannot reach the worker admin API; the trusted host-network agent reloads worker routes only by executing the Caddy CLI inside the Caddy container against its loopback admin address.
- Workers have no public IP; port 8080 accepts traffic only from instances tagged as the managed gateway.
- SSH uses Google OS Login through Identity-Aware Proxy. Port 22 accepts traffic only from Google's IAP TCP-forwarding range.
- Applications run in tenant-specific containers, networks, and volumes on a capacity-selected worker.
- The trusted worker agent uses host networking only for identity enrollment and operations. A persistent `DOCKER-USER` firewall rule rejects every bridged tenant container request to the IPv4 and IPv6 Google metadata addresses, including after Docker restarts.
- Worker agents use renewable job leases and API-scoped credentials instead of direct database access.
- Secrets must not be committed to the repository or placed in Terraform state.
- Backups must be encrypted and copied outside the VM before production use.

## Remove the host

An ordinary destroy is intentionally blocked by instance deletion protection. Export application data and verify off-instance restores first. Disabling protection and retiring a retained boot disk are separate, destructive changes that require their own reviewed plan; the checked-in configuration must not be weakened merely to make this command succeed:

```sh
terraform -chdir=infra/google-cloud destroy
```

Because boot-disk auto-delete is disabled, deleting an instance does not automatically delete its disk. Inventory every retained disk after an approved retirement, preserve it for the recovery window, and delete it separately only after restore evidence and storage-cost review.
