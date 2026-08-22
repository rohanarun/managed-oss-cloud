# Self-host on Google Cloud

This path creates a dedicated control-plane VM plus an optional pool of private application workers. The same architecture powers the hosted service; a self-hosting customer keeps the Google Cloud project and billing authority.

## Cost boundary

The control plane and every worker are separate billable resources. The included Terraform reserves one external IPv4 for stable customer DNS; workers use private IPs and shared Cloud NAT for outbound image pulls and updates. Persistent disks, traffic, NAT, backups, and each worker VM are additional costs. Do not price the hosted product as if one free-tier micro VM can serve hundreds of customer applications.

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

Terraform prints the static IPv4, dashboard URL, control-plane SSH command, private worker addresses, and the configured capacity envelope. The control plane runs PostgreSQL, the API, and the edge Caddy gateway. Each worker runs only its authenticated agent, a private Caddy listener, and assigned tenant containers. Keep `PROVISIONING_MODE=dry-run`, `BILLING_MODE=disabled`, and `worker_count=0` until the live-provisioning gates in the README pass.

Set `control_plane_domain` and `apps_domain` in `terraform.tfvars` before production DNS. For a reproducible production deploy, replace the container's `latest` tag with the digest published by GitHub Actions. Stripe and backup keys belong in Google Secret Manager; the runtime service account receives access only to the named secrets and backup bucket.

The checked-in `deploy/google-cloud` and `deploy/google-cloud/worker` files are the two runtime templates. `CONTROL_PLANE_IMAGE` must contain an immutable GHCR digest. Keep all generated environment and agent-token files mode `0600`; they must never be committed. PostgreSQL reads only `postgres.env`. Workers never receive the database URL, Stripe secrets, session secrets, or gateway token.

The backup bucket should enforce public-access prevention and uniform bucket-level access. Terraform gives each worker object create/view access only beneath that worker's object prefix. Backups are encrypted before upload, and workers receive no delete permission.

## Connect domains

Point the hosted wildcard to the printed edge IPv4, then let customers CNAME their domains to the application hostname shown in the dashboard:

```text
*.apps.example.com       A      203.0.113.10
calendar.customer.com    CNAME  cal-abcd.apps.example.com
```

The edge gateway verifies the custom domain, obtains TLS, and proxies over the private subnet to the assigned worker. Workers are never direct DNS targets.

## Capacity

The catalogue is not licence-limited. Running capacity is finite. The default `e2-medium` is only the control plane. Default application workers are `e2-standard-2` nodes advertising 7,168 MB and 1,800 CPU-millis after an explicit system reserve. Verified app reservations are enforced before placement. When no worker fits, the install remains queued and capacity must be added; the scheduler does not silently overload an existing tenant node.

Hundreds of customers therefore means a fleet, not one larger VM. The exact node count depends on the mix of applications, active usage, storage, and outbound email/traffic. Increase `worker_count` in a reviewed Terraform plan, or use the same worker registration API from a separately governed autoscaler after drain and cost controls are proven.

## Security boundary

- Only control-plane ports 80 and 443 are opened publicly.
- Workers have no public IP; port 8080 accepts traffic only from instances tagged as the managed gateway.
- SSH uses Google OS Login through Identity-Aware Proxy. Port 22 accepts traffic only from Google's IAP TCP-forwarding range.
- Applications run in tenant-specific containers, networks, and volumes on a capacity-selected worker.
- Worker agents use renewable job leases and API-scoped credentials instead of direct database access.
- Secrets must not be committed to the repository or placed in Terraform state.
- Backups must be encrypted and copied outside the VM before production use.

## Remove the host

Review the Terraform plan, export application data, and then run:

```sh
terraform -chdir=infra/google-cloud destroy
```

Destroying the VM and disk deletes application data. Verify backups first.
