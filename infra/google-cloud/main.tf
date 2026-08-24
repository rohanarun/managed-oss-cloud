resource "google_project_service" "secret_manager" {
  project            = var.project_id
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "managed-oss-host"
  display_name = "Managed OSS host runtime"
}

resource "google_service_account" "worker" {
  count        = var.worker_count
  project      = var.project_id
  account_id   = "managed-oss-worker-${count.index}"
  display_name = "Managed OSS private worker ${count.index}"
}

resource "google_secret_manager_secret_iam_member" "stripe" {
  count      = var.billing_mode == "live" ? 1 : 0
  project    = var.project_id
  secret_id  = var.stripe_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "stripe_webhook" {
  count      = var.billing_mode == "live" ? 1 : 0
  project    = var.project_id
  secret_id  = var.stripe_webhook_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "backup_key" {
  count      = var.worker_count
  project    = var.project_id
  secret_id  = var.backup_key_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.worker[count.index].email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "worker_bootstrap_control" {
  project    = var.project_id
  secret_id  = var.worker_bootstrap_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "gateway_reconciler" {
  project    = var.project_id
  secret_id  = var.gateway_reconciler_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "consent_policy_signing" {
  project    = var.project_id
  secret_id  = var.consent_policy_signing_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "extended_external_evidence" {
  project    = var.project_id
  secret_id  = var.extended_external_evidence_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

locals {
  google_oauth_secret_names = toset([
    var.google_oauth_client_id_secret_name,
    var.google_oauth_client_secret_secret_name,
    var.google_oauth_state_secret_name,
    var.google_oauth_callback_url_secret_name,
    var.google_oauth_assertion_signing_secret_name,
  ])
}

resource "google_secret_manager_secret_iam_member" "google_oauth_control" {
  for_each   = local.google_oauth_secret_names
  project    = var.project_id
  secret_id  = each.value
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_storage_bucket_iam_member" "backup_creator" {
  count  = var.backup_bucket != "" ? var.worker_count : 0
  bucket = var.backup_bucket
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.worker[count.index].email}"
  condition {
    title       = "worker-${count.index}-backup-prefix"
    description = "Restrict this worker to its own encrypted backup objects."
    expression  = "resource.name.startsWith('projects/_/buckets/${var.backup_bucket}/objects/${var.instance_name}-worker-${count.index}/')"
  }
}

resource "google_storage_bucket_iam_member" "backup_reader" {
  count  = var.backup_bucket != "" ? var.worker_count : 0
  bucket = var.backup_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.worker[count.index].email}"
  condition {
    title       = "worker-${count.index}-restore-prefix"
    description = "Restrict this worker to restoring its own encrypted backup objects."
    expression  = "resource.name.startsWith('projects/_/buckets/${var.backup_bucket}/objects/${var.instance_name}-worker-${count.index}/')"
  }
}

resource "google_storage_bucket_iam_member" "control_plane_backup_creator" {
  count  = var.backup_bucket != "" ? 1 : 0
  bucket = var.backup_bucket
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.runtime.email}"
  condition {
    title       = "control-plane-backup-prefix"
    description = "Restrict the control plane to immutable logical backup creation."
    expression  = "resource.name.startsWith('projects/_/buckets/${var.backup_bucket}/objects/control-plane/')"
  }
}

resource "google_storage_bucket_iam_member" "control_plane_backup_reader" {
  count  = var.backup_bucket != "" ? 1 : 0
  bucket = var.backup_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
  condition {
    title       = "control-plane-restore-prefix"
    description = "Restrict explicit restore verification to control-plane backups."
    expression  = "resource.name.startsWith('projects/_/buckets/${var.backup_bucket}/objects/control-plane/')"
  }
}

resource "google_compute_address" "managed_oss" {
  name   = "${var.instance_name}-ipv4"
  region = var.region
}

resource "google_compute_network" "managed_oss" {
  name                    = "${var.instance_name}-network"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "managed_oss" {
  name          = "${var.instance_name}-subnet"
  ip_cidr_range = "10.70.0.0/24"
  region        = var.region
  network       = google_compute_network.managed_oss.id
}

resource "google_compute_router" "managed_oss" {
  name    = "${var.instance_name}-router"
  region  = var.region
  network = google_compute_network.managed_oss.id
}

resource "google_compute_router_nat" "workers" {
  name                               = "${var.instance_name}-worker-nat"
  router                             = google_compute_router.managed_oss.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.managed_oss.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

resource "google_compute_firewall" "web" {
  name    = "${var.instance_name}-web"
  network = google_compute_network.managed_oss.id

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["managed-oss-web"]
}

resource "google_compute_firewall" "ssh_iap" {
  name    = "${var.instance_name}-ssh-iap"
  network = google_compute_network.managed_oss.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["managed-oss-ssh"]
}

resource "google_compute_firewall" "gateway_to_workers" {
  name    = "${var.instance_name}-gateway-workers"
  network = google_compute_network.managed_oss.id

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  source_tags = ["managed-oss-gateway"]
  target_tags = ["managed-oss-worker"]
}

resource "google_compute_instance" "managed_oss" {
  name                = var.instance_name
  machine_type        = var.machine_type
  zone                = var.zone
  deletion_protection = true
  tags                = ["managed-oss-web", "managed-oss-ssh", "managed-oss-gateway"]

  boot_disk {
    auto_delete = false
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = var.disk_size_gb
      type  = "pd-standard"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.managed_oss.id

    access_config {
      nat_ip = google_compute_address.managed_oss.address
    }
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  service_account {
    email  = google_service_account.runtime.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  metadata_startup_script = <<-STARTUP
    #!/usr/bin/env bash
    set -euo pipefail
    rm -f /opt/managed-oss/.host-ready
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose ca-certificates curl jq openssl
    GH_INSTALL_DIR="$(mktemp -d /tmp/managed-oss-gh.XXXXXXXX)"
    curl -fsSLo "$${GH_INSTALL_DIR}/gh.tar.gz" "https://github.com/cli/cli/releases/download/v${var.github_cli_version}/gh_${var.github_cli_version}_linux_amd64.tar.gz"
    printf '%s  %s\n' '${var.github_cli_linux_amd64_sha256}' "$${GH_INSTALL_DIR}/gh.tar.gz" | sha256sum -c -
    tar -xzf "$${GH_INSTALL_DIR}/gh.tar.gz" -C "$${GH_INSTALL_DIR}"
    install -m 0755 "$${GH_INSTALL_DIR}/gh_${var.github_cli_version}_linux_amd64/bin/gh" /usr/local/bin/gh
    rm -rf -- "$${GH_INSTALL_DIR}"
    systemctl enable --now docker
    install -d -m 0750 /opt/managed-oss/apps /opt/managed-oss/backups /opt/managed-oss/config /opt/managed-oss/database /opt/managed-oss/readiness /opt/managed-oss/provenance /opt/managed-oss/security
    install -d -m 0755 /etc/systemd/system/docker.service.d
    if [ ! -f /opt/managed-oss/config/postgres.env ]; then
      umask 077
      POSTGRES_PASSWORD="$(openssl rand -hex 32)"
      cat > /opt/managed-oss/config/postgres.env <<EOF
    POSTGRES_PASSWORD=$${POSTGRES_PASSWORD}
    EOF
    fi
    POSTGRES_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/managed-oss/config/postgres.env)"
    [[ "$${POSTGRES_PASSWORD}" =~ ^[a-f0-9]{64}$ ]]
    access_secret() {
      local secret_name="$1"
      local secret_version="$2"
      local access_token
      access_token="$(curl -fsS -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | jq -r .access_token)"
      curl -fsS -H "Authorization: Bearer $${access_token}" "https://secretmanager.googleapis.com/v1/projects/${var.project_id}/secrets/$${secret_name}/versions/$${secret_version}:access" | jq -r .payload.data | base64 -d
    }
    umask 077
    cat > /opt/managed-oss/config/billing.env <<EOF
    STRIPE_SECRET_KEY=
    STRIPE_PUBLISHABLE_KEY=${var.stripe_publishable_key}
    STRIPE_WEBHOOK_SECRET=
    BILLING_MODE=disabled
    EOF
    ${var.billing_mode == "live" ? "STRIPE_SECRET_KEY=\"$(access_secret '${var.stripe_secret_name}' '${var.stripe_secret_version}')\"\nSTRIPE_WEBHOOK_SECRET=\"$(access_secret '${var.stripe_webhook_secret_name}' '${var.stripe_webhook_secret_version}')\"\ncat > /opt/managed-oss/config/billing.env <<EOF\nSTRIPE_SECRET_KEY=$${STRIPE_SECRET_KEY}\nSTRIPE_PUBLISHABLE_KEY=${var.stripe_publishable_key}\nSTRIPE_WEBHOOK_SECRET=$${STRIPE_WEBHOOK_SECRET}\nBILLING_MODE=live\nEOF" : ""}
    WORKER_BOOTSTRAP_TOKEN="$(access_secret '${var.worker_bootstrap_secret_name}' '${var.worker_bootstrap_secret_version}')"
    GATEWAY_RECONCILER_TOKEN="$(access_secret '${var.gateway_reconciler_secret_name}' '${var.gateway_reconciler_secret_version}')"
    CONSENT_POLICY_SIGNING_PRIVATE_KEY="$(access_secret '${var.consent_policy_signing_secret_name}' '${var.consent_policy_signing_secret_version}')"
    EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET="$(access_secret '${var.extended_external_evidence_secret_name}' '${var.extended_external_evidence_secret_version}')"
    GOOGLE_OAUTH_CLIENT_ID="$(access_secret '${var.google_oauth_client_id_secret_name}' '${var.google_oauth_client_id_secret_version}')"
    GOOGLE_OAUTH_CLIENT_SECRET="$(access_secret '${var.google_oauth_client_secret_secret_name}' '${var.google_oauth_client_secret_secret_version}')"
    GOOGLE_OAUTH_STATE_SECRET="$(access_secret '${var.google_oauth_state_secret_name}' '${var.google_oauth_state_secret_version}')"
    GOOGLE_OAUTH_CALLBACK_URL="$(access_secret '${var.google_oauth_callback_url_secret_name}' '${var.google_oauth_callback_url_secret_version}')"
    GOOGLE_OAUTH_ASSERTION_SIGNING_PRIVATE_KEY="$(access_secret '${var.google_oauth_assertion_signing_secret_name}' '${var.google_oauth_assertion_signing_secret_version}')"
    cat > /opt/managed-oss/config/oauth.env <<EOF
    GOOGLE_OAUTH_CLIENT_ID=$${GOOGLE_OAUTH_CLIENT_ID}
    GOOGLE_OAUTH_CLIENT_SECRET=$${GOOGLE_OAUTH_CLIENT_SECRET}
    GOOGLE_OAUTH_STATE_SECRET=$${GOOGLE_OAUTH_STATE_SECRET}
    GOOGLE_OAUTH_CALLBACK_URL=$${GOOGLE_OAUTH_CALLBACK_URL}
    GOOGLE_OAUTH_ASSERTION_SIGNING_PRIVATE_KEY=$${GOOGLE_OAUTH_ASSERTION_SIGNING_PRIVATE_KEY}
    GOOGLE_OAUTH_BROKER_START_URL=https://${var.control_plane_domain}/oauth/google/start
    GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY=${var.google_oauth_assertion_public_key}
    EOF
    cat > /opt/managed-oss/config/control-plane.env <<EOF
    WORKER_BOOTSTRAP_TOKEN=$${WORKER_BOOTSTRAP_TOKEN}
    ${var.worker_count > 0 ? "GCP_WORKER_IDENTITY_AUDIENCE=https://${var.control_plane_domain}/api/agent/register\n    GCP_WORKER_IDENTITY_PROJECT_ID=${var.project_id}\n    GCP_WORKER_IDENTITY_INSTANCE_NAMES=${join(",", [for index in range(var.worker_count) : "${var.instance_name}-worker-${index}"])}\n    GCP_WORKER_IDENTITY_ZONES=${var.zone}" : ""}
    CONSENT_POLICY_SIGNING_PRIVATE_KEY=$${CONSENT_POLICY_SIGNING_PRIVATE_KEY}
    CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS_JSON=${jsonencode(var.consent_policy_previous_public_keys)}
    EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET=$${EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET}
    EOF
    cat > /opt/managed-oss/config/gateway.env <<EOF
    GATEWAY_RECONCILER_TOKEN=$${GATEWAY_RECONCILER_TOKEN}
    CADDY_ADMIN_URL=http://127.0.0.1:2019/load
    EOF
    cat > /opt/managed-oss/config/runtime.env <<EOF
    CONTROL_PLANE_IMAGE=${var.control_plane_image}
    PUBLIC_APP_URL=${var.control_plane_domain != "" ? "https://${var.control_plane_domain}" : "http://${google_compute_address.managed_oss.address}"}
    PUBLIC_HOST_TARGET=${var.apps_domain}
    PROVISIONING_MODE=${var.provisioning_mode}
    PROVISIONING_WORKER=disabled
    DATABASE_MIGRATION_MODE=manual
    SUITE_ENTITLEMENT_MODE=hosted
    HOSTING_ENTITLEMENT_MODE=hosted
    WORKER_STORAGE_QUOTA_BACKEND=${var.worker_storage_quota_backend}
    WORKER_STORAGE_QUOTA_PROOF_COMPLETED=${var.worker_storage_quota_proof_completed}
    SUBSCRIPTION_RECONCILIATION_MODE=${var.billing_mode == "live" ? var.subscription_reconciliation_mode : "disabled"}
    SUBSCRIPTION_RECONCILIATION_INTERVAL_MILLISECONDS=${var.subscription_reconciliation_interval_milliseconds}
    COMPOSE_PROFILES=${var.billing_mode == "live" && var.subscription_reconciliation_mode != "disabled" ? "billing" : ""}
    CONTROL_PLANE_DOMAIN=${var.control_plane_domain}
    PLATFORM_IPV4=${google_compute_address.managed_oss.address}
    EOF
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/docker-compose.yml")}' | base64 -d > /opt/managed-oss/config/docker-compose.yml
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/Caddyfile")}' | base64 -d > /opt/managed-oss/config/Caddyfile
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/readiness/control-plane-ready.sh")}' | base64 -d > /opt/managed-oss/readiness/control-plane-ready.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/provenance/verify-control-plane-image.sh")}' | base64 -d > /opt/managed-oss/provenance/verify-control-plane-image.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/database/configure-role-logins.sh")}' | base64 -d > /opt/managed-oss/database/configure-role-logins.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/metadata-firewall.sh")}' | base64 -d > /opt/managed-oss/security/metadata-firewall.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/metadata-firewall-proof.sh")}' | base64 -d > /opt/managed-oss/security/metadata-firewall-proof.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/managed-oss-metadata-firewall.service")}' | base64 -d > /etc/systemd/system/managed-oss-metadata-firewall.service
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/docker-metadata-firewall.conf")}' | base64 -d > /etc/systemd/system/docker.service.d/managed-oss-metadata-firewall.conf
    chmod 0750 /opt/managed-oss/readiness/control-plane-ready.sh
    chmod 0750 /opt/managed-oss/provenance/verify-control-plane-image.sh
    chmod 0750 /opt/managed-oss/database/configure-role-logins.sh
    chmod 0750 /opt/managed-oss/security/metadata-firewall.sh /opt/managed-oss/security/metadata-firewall-proof.sh
    systemctl daemon-reload
    systemctl enable --now managed-oss-metadata-firewall.service
    install -d -m 0750 /opt/managed-oss/backup-deploy/systemd
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/backup/control-plane-backup.sh")}' | base64 -d > /opt/managed-oss/backup-deploy/control-plane-backup.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/backup/control-plane-restore-verify.sh")}' | base64 -d > /opt/managed-oss/backup-deploy/control-plane-restore-verify.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/backup/install.sh")}' | base64 -d > /opt/managed-oss/backup-deploy/install.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/backup/control-plane-backup.env.example")}' | base64 -d > /opt/managed-oss/backup-deploy/control-plane-backup.env.example
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/backup/systemd/managed-oss-control-plane-backup.service")}' | base64 -d > /opt/managed-oss/backup-deploy/systemd/managed-oss-control-plane-backup.service
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/backup/systemd/managed-oss-control-plane-backup.timer")}' | base64 -d > /opt/managed-oss/backup-deploy/systemd/managed-oss-control-plane-backup.timer
    chmod 0750 /opt/managed-oss/backup-deploy/*.sh
    cat > /opt/managed-oss/config/control-plane-backup.env <<EOF
    CONTROL_PLANE_BACKUP_BUCKET=${var.backup_bucket}
    CONTROL_PLANE_BACKUP_PREFIX=control-plane
    CONTROL_PLANE_BACKUP_COMPOSE_DIR=/opt/managed-oss/config
    CONTROL_PLANE_BACKUP_COMPOSE_FILE=docker-compose.yml
    CONTROL_PLANE_BACKUP_COMPOSE_ENV_FILE=runtime.env
    CONTROL_PLANE_BACKUP_WORK_DIR=/opt/managed-oss/backups/control-plane
    CONTROL_PLANE_BACKUP_POSTGRES_DATA_DIR=/opt/managed-oss/apps/postgres
    CONTROL_PLANE_BACKUP_DATABASE_SERVICE=database
    CONTROL_PLANE_BACKUP_DATABASE_NAME=opendock
    CONTROL_PLANE_BACKUP_DATABASE_USER=opendock
    CONTROL_PLANE_BACKUP_MAX_UPLOAD_SECONDS=1800
    CONTROL_PLANE_BACKUP_MAX_DOWNLOAD_SECONDS=1800
    EOF
    chmod 0600 /opt/managed-oss/config/control-plane-backup.env
    /opt/managed-oss/backup-deploy/install.sh
    cd /opt/managed-oss/config
    if [ ! -f database-role-passwords.env ]; then
      cat > database-migrator.env <<EOF
    DATABASE_MIGRATOR_URL=postgresql://opendock:$${POSTGRES_PASSWORD}@database:5432/opendock
    EOF
    fi
    for service_env in database-control.env database-suite.env database-ai.env; do
      if [ ! -f "$${service_env}" ]; then
        install -m 0600 /dev/null "$${service_env}"
      fi
    done
    chmod 0600 postgres.env runtime.env control-plane.env gateway.env oauth.env billing.env database-migrator.env database-control.env database-suite.env database-ai.env
    set -a
    source runtime.env
    set +a
    CONTROL_IMAGE_HEX="$${CONTROL_PLANE_IMAGE##*@sha256:}"
    PROVENANCE_PROOF="/opt/managed-oss/provenance/startup-$${CONTROL_IMAGE_HEX}-${var.control_plane_source_commit}-$(date -u +%Y%m%dT%H%M%SZ).json"
    /opt/managed-oss/provenance/verify-control-plane-image.sh --image "$${CONTROL_PLANE_IMAGE}" --source-commit '${var.control_plane_source_commit}' --proof-file "$${PROVENANCE_PROOF}" >/dev/null
    docker pull "$${CONTROL_PLANE_IMAGE}" >/dev/null
    /opt/managed-oss/security/metadata-firewall-proof.sh "$${CONTROL_PLANE_IMAGE}" > /opt/managed-oss/security/control-plane-metadata-proof.json
    jq -e '.ok == true and .hostMetadata == true and .bridgeIpv4Blocked == true and .bridgeIpv6Blocked == true' /opt/managed-oss/security/control-plane-metadata-proof.json >/dev/null
    chmod 0640 /opt/managed-oss/security/control-plane-metadata-proof.json
    docker-compose --profile operations pull
    docker-compose up -d database
    DATABASE_READY=false
    for attempt in $(seq 1 60); do
      if docker-compose exec -T database pg_isready -q -h 127.0.0.1 -U opendock -d opendock; then
        DATABASE_READY=true
        break
      fi
      sleep 2
    done
    [[ "$${DATABASE_READY}" == "true" ]]
    printf '%s\n' "$${POSTGRES_PASSWORD}" | docker-compose exec -T database sh -ceu '
      IFS= read -r PGPASSWORD
      export PGPASSWORD
      psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U opendock -d opendock -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
    '
    POSTGRES_PASSWORD=""
    docker-compose --profile operations run --rm migrate
    MANAGED_OSS_COMPOSE_DIR=/opt/managed-oss/config /opt/managed-oss/database/configure-role-logins.sh
    docker-compose up -d
    EXPECTED_PROVISIONING_MODE=${var.provisioning_mode} \
      MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE=/opt/managed-oss/security/control-plane-metadata-proof.json \
      MANAGED_OSS_READY_TIMEOUT_SECONDS=${var.startup_readiness_timeout_seconds} \
      /opt/managed-oss/readiness/control-plane-ready.sh
    if [ '${var.control_plane_backup_timer_enabled}' = 'true' ]; then
      /opt/managed-oss/backup-deploy/install.sh --enable --first-restore-proof-completed
    fi
  STARTUP

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  lifecycle {
    precondition {
      condition     = startswith(var.zone, "${var.region}-")
      error_message = "The selected zone must belong to the selected region."
    }
    precondition {
      condition     = var.billing_mode == "live" || var.subscription_reconciliation_mode == "disabled"
      error_message = "Scheduled subscription reconciliation requires billing_mode=live."
    }
    precondition {
      condition     = var.billing_mode != "live" || (var.provisioning_mode == "live" && var.worker_count >= 1 && var.subscription_reconciliation_mode == "apply")
      error_message = "Production billing requires provisioning_mode=live, at least one worker, and subscription_reconciliation_mode=apply so checkout cannot charge without provisioning and fail-closed reconciliation."
    }
    precondition {
      condition     = var.billing_mode != "live" || (var.worker_storage_quota_backend == "operator-project-quota" && var.worker_storage_quota_proof_completed)
      error_message = "Production billing requires an operator-provisioned hard project-quota backend and a completed exact-limit enforcement proof on every worker; measurement-only ext4 scanning is not a hard quota."
    }
    precondition {
      condition     = !var.control_plane_backup_timer_enabled || var.backup_bucket != ""
      error_message = "The control-plane backup timer requires a configured private backup_bucket."
    }
    precondition {
      condition     = !var.control_plane_backup_timer_enabled || var.control_plane_restore_proof_completed
      error_message = "The control-plane backup timer remains disabled until control_plane_restore_proof_completed acknowledges a successful first backup and isolated restore-verification drill."
    }
  }
}

resource "google_compute_instance" "worker" {
  count               = var.worker_count
  name                = "${var.instance_name}-worker-${count.index}"
  machine_type        = var.worker_machine_type
  zone                = var.zone
  deletion_protection = true
  tags                = ["managed-oss-worker", "managed-oss-ssh"]

  boot_disk {
    auto_delete = false
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = var.worker_disk_size_gb
      type  = "pd-standard"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.managed_oss.id
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  service_account {
    email  = google_service_account.worker[count.index].email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  metadata_startup_script = <<-STARTUP
    #!/usr/bin/env bash
    set -euo pipefail
    rm -f /opt/managed-oss/.worker-ready
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose ca-certificates curl jq
    GH_INSTALL_DIR="$(mktemp -d /tmp/managed-oss-gh.XXXXXXXX)"
    curl -fsSLo "$${GH_INSTALL_DIR}/gh.tar.gz" "https://github.com/cli/cli/releases/download/v${var.github_cli_version}/gh_${var.github_cli_version}_linux_amd64.tar.gz"
    printf '%s  %s\n' '${var.github_cli_linux_amd64_sha256}' "$${GH_INSTALL_DIR}/gh.tar.gz" | sha256sum -c -
    tar -xzf "$${GH_INSTALL_DIR}/gh.tar.gz" -C "$${GH_INSTALL_DIR}"
    install -m 0755 "$${GH_INSTALL_DIR}/gh_${var.github_cli_version}_linux_amd64/bin/gh" /usr/local/bin/gh
    rm -rf -- "$${GH_INSTALL_DIR}"
    systemctl enable --now docker
    install -d -m 0750 /opt/managed-oss/apps/workspaces /opt/managed-oss/config /opt/managed-oss/agent /opt/managed-oss/readiness /opt/managed-oss/provenance /opt/managed-oss/security /opt/managed-oss/quota /opt/managed-oss/quota/bin
    install -d -m 0755 /etc/systemd/system/docker.service.d
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/metadata-firewall.sh")}' | base64 -d > /opt/managed-oss/security/metadata-firewall.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/metadata-firewall-proof.sh")}' | base64 -d > /opt/managed-oss/security/metadata-firewall-proof.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/managed-oss-metadata-firewall.service")}' | base64 -d > /etc/systemd/system/managed-oss-metadata-firewall.service
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/docker-metadata-firewall.conf")}' | base64 -d > /etc/systemd/system/docker.service.d/managed-oss-metadata-firewall.conf
    chmod 0750 /opt/managed-oss/security/metadata-firewall.sh /opt/managed-oss/security/metadata-firewall-proof.sh
    systemctl daemon-reload
    systemctl enable --now managed-oss-metadata-firewall.service
    docker network inspect managed-oss-worker-platform >/dev/null 2>&1 || docker network create managed-oss-worker-platform
    metadata() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"; }
    access_secret() {
      local secret_name="$1"
      local secret_version="$2"
      local access_token
      access_token="$(metadata instance/service-accounts/default/token | jq -r .access_token)"
      curl -fsS -H "Authorization: Bearer $${access_token}" "https://secretmanager.googleapis.com/v1/projects/${var.project_id}/secrets/$${secret_name}/versions/$${secret_version}:access" | jq -r .payload.data | base64 -d
    }
    WORKER_PRIVATE_ADDRESS="$(metadata instance/network-interfaces/0/ip)"
    BACKUP_KEY_HEX="$(access_secret '${var.backup_key_secret_name}' '${var.backup_key_secret_version}')"
    umask 077
    cat > /opt/managed-oss/config/worker.env <<EOF
    CONTROL_PLANE_IMAGE=${var.control_plane_image}
    CONTROL_PLANE_AGENT_URL=https://${var.control_plane_domain}
    GCP_WORKER_IDENTITY_AUDIENCE=https://${var.control_plane_domain}/api/agent/register
    WORKER_NODE_ID=${var.instance_name}-worker-${count.index}
    WORKER_NODE_NAME=${var.instance_name}-worker-${count.index}
    WORKER_PRIVATE_ADDRESS=$${WORKER_PRIVATE_ADDRESS}
    WORKER_MACHINE_TYPE=${var.worker_machine_type}
    WORKER_CAPACITY_MEMORY_MB=${var.worker_capacity_memory_mb}
    WORKER_CAPACITY_CPU_MILLIS=${var.worker_capacity_cpu_millis}
    WORKER_CAPACITY_STORAGE_GB=${var.worker_capacity_storage_gb}
    WORKER_SYSTEM_RESERVE_MEMORY_MB=${var.worker_system_reserve_memory_mb}
    WORKER_SYSTEM_RESERVE_CPU_MILLIS=${var.worker_system_reserve_cpu_millis}
    WORKER_SYSTEM_RESERVE_STORAGE_GB=${var.worker_system_reserve_storage_gb}
    WORKER_STORAGE_QUOTA_BACKEND=${var.worker_storage_quota_backend}
    WORKER_STORAGE_QUOTA_PROOF_COMPLETED=${var.worker_storage_quota_proof_completed}
    ${var.worker_storage_quota_backend == "operator-project-quota" ? "WORKER_STORAGE_QUOTA_HELPER=${var.worker_storage_quota_helper}" : ""}
    BACKUP_KEY_HEX=$${BACKUP_KEY_HEX}
    BACKUP_BUCKET=${var.backup_bucket}
    GOOGLE_OAUTH_BROKER_START_URL=https://${var.control_plane_domain}/oauth/google/start
    GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY=${var.google_oauth_assertion_public_key}
    EOF
    touch /opt/managed-oss/config/apps.caddy
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/Caddyfile")}' | base64 -d > /opt/managed-oss/config/worker-Caddyfile
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/worker/docker-compose.yml")}' | base64 -d > /opt/managed-oss/config/docker-compose.yml
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/readiness/worker-ready.sh")}' | base64 -d > /opt/managed-oss/readiness/worker-ready.sh
    printf '%s' '${filebase64("${path.module}/../../deploy/google-cloud/provenance/verify-control-plane-image.sh")}' | base64 -d > /opt/managed-oss/provenance/verify-control-plane-image.sh
    chmod 0750 /opt/managed-oss/readiness/worker-ready.sh
    chmod 0750 /opt/managed-oss/provenance/verify-control-plane-image.sh
    cd /opt/managed-oss/config
    set -a
    source worker.env
    set +a
    CONTROL_IMAGE_HEX="$${CONTROL_PLANE_IMAGE##*@sha256:}"
    PROVENANCE_PROOF="/opt/managed-oss/provenance/startup-$${CONTROL_IMAGE_HEX}-${var.control_plane_source_commit}-$(date -u +%Y%m%dT%H%M%SZ).json"
    /opt/managed-oss/provenance/verify-control-plane-image.sh --image "$${CONTROL_PLANE_IMAGE}" --source-commit '${var.control_plane_source_commit}' --proof-file "$${PROVENANCE_PROOF}" >/dev/null
    docker pull "$${CONTROL_PLANE_IMAGE}" >/dev/null
    METADATA_PROOF="/opt/managed-oss/security/worker-metadata-$${CONTROL_IMAGE_HEX}-$(date -u +%Y%m%dT%H%M%SZ).json"
    METADATA_FIREWALL_SCRIPT=/opt/managed-oss/security/metadata-firewall.sh \
      /opt/managed-oss/security/metadata-firewall-proof.sh "$${CONTROL_PLANE_IMAGE}" > "$${METADATA_PROOF}"
    chmod 0640 "$${METADATA_PROOF}"
    jq -e '.ok == true and .hostMetadata == true and .bridgeIpv4Blocked == true and .bridgeIpv6Blocked == true' "$${METADATA_PROOF}" >/dev/null
    docker-compose pull
    WORKER_READINESS_NOT_BEFORE_EPOCH="$(date +%s)"
    docker-compose up -d
    WORKER_READINESS_NOT_BEFORE_EPOCH="$${WORKER_READINESS_NOT_BEFORE_EPOCH}" \
      MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$${METADATA_PROOF}" \
      MANAGED_OSS_READY_TIMEOUT_SECONDS=${var.startup_readiness_timeout_seconds} \
      /opt/managed-oss/readiness/worker-ready.sh
  STARTUP

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  lifecycle {
    precondition {
      condition     = var.control_plane_domain != ""
      error_message = "Private workers require an HTTPS control_plane_domain."
    }
    precondition {
      condition     = var.worker_capacity_memory_mb > var.worker_system_reserve_memory_mb
      error_message = "Worker schedulable memory must exceed the system reserve."
    }
    precondition {
      condition     = var.worker_capacity_storage_gb + var.worker_system_reserve_storage_gb <= var.worker_disk_size_gb
      error_message = "Advertised worker storage must leave disk space for the OS, images, and operations."
    }
    precondition {
      condition     = var.worker_capacity_cpu_millis + var.worker_system_reserve_cpu_millis <= var.worker_physical_cpu_millis
      error_message = "Advertised worker CPU plus its system reserve must not exceed the reviewed physical CPU capacity."
    }
  }

  depends_on = [google_compute_router_nat.workers]
}
