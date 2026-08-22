# Self-host on Google Cloud

This path creates a dedicated Google Compute Engine VM in your own project. The hosted control plane never receives the project's billing credentials.

## Cost boundary

Eligible Google Cloud billing accounts receive a monthly allowance equal to one non-preemptible `e2-micro` in `us-west1`, `us-central1`, or `us-east1`, 30 GB-months of standard persistent disk, and 1 GB of outbound traffic. The allowance is shared across the billing account; it is not repeated for every project or customer.

The included Terraform configuration reserves an external IPv4 so custom-domain DNS remains stable. Google bills an in-use IPv4 separately. Additional traffic, snapshots, larger disks, and larger machine types also cost extra.

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

Terraform prints the static IPv4, dashboard URL, and an SSH command. The first boot installs Docker, starts PostgreSQL, the Managed OSS Cloud control plane, and Caddy, then prepares `/opt/managed-oss` for application data, configuration, and backups. Keep `PROVISIONING_MODE=dry-run` until the live-provisioning gates in the README pass.

Set `control_plane_domain` and `apps_domain` in `terraform.tfvars` before production DNS. For a reproducible production deploy, replace the container's `latest` tag with the digest published by GitHub Actions. Stripe and backup keys belong in Google Secret Manager; the runtime service account receives access only to the named secrets and backup bucket.

The checked-in `deploy/google-cloud` Compose and Caddy files are the production runtime templates. `CONTROL_PLANE_IMAGE` must contain an immutable GHCR digest. Keep `billing.env`, `worker.env`, and `runtime.env` mode `0600`; they are host-created secret files and must never be committed.

The backup bucket should enforce public-access prevention and uniform bucket-level access. Grant the runtime identity `roles/storage.objectCreator` plus `roles/storage.objectViewer`; it can create and restore encrypted backup objects but cannot delete them.

## Connect domains

Create an `A` record for each application hostname using the printed IPv4:

```text
calendar.example.com  A  203.0.113.10
forms.example.com     A  203.0.113.10
sign.example.com      A  203.0.113.10
```

The reverse proxy will route each hostname to its application and request a TLS certificate after DNS resolves.

## Capacity

The catalogue is not licence-limited. Running capacity is finite:

- `e2-micro`: 1 GB RAM and 0.25 sustained vCPU;
- `e2-small`: 2 GB RAM and 0.5 sustained vCPU;
- `e2-medium`: 4 GB RAM and 1 sustained vCPU.

The control plane must stop an install before its combined application budgets exceed the configured safety threshold. Upgrade the machine type or move a heavy application to a second VM when necessary.

## Security boundary

- Only ports 80 and 443 are opened publicly.
- SSH uses Google OS Login through Identity-Aware Proxy. Port 22 accepts traffic only from Google's IAP TCP-forwarding range.
- Applications run in separate containers, networks, and volumes.
- Secrets must not be committed to the repository or placed in Terraform state.
- Backups must be encrypted and copied outside the VM before production use.

## Remove the host

Review the Terraform plan, export application data, and then run:

```sh
terraform -chdir=infra/google-cloud destroy
```

Destroying the VM and disk deletes application data. Verify backups first.
