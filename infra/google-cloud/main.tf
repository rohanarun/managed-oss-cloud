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
  project    = var.project_id
  secret_id  = var.backup_key_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_storage_bucket_iam_member" "backup_creator" {
  count  = var.backup_bucket != "" ? 1 : 0
  bucket = var.backup_bucket
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "backup_reader" {
  count  = var.backup_bucket != "" ? 1 : 0
  bucket = var.backup_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
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

resource "google_compute_instance" "managed_oss" {
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["managed-oss-web", "managed-oss-ssh"]

  boot_disk {
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
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose ca-certificates curl jq openssl
    systemctl enable --now docker
    install -d -m 0750 /opt/managed-oss/apps /opt/managed-oss/backups /opt/managed-oss/config
    if [ ! -f /opt/managed-oss/config/runtime.env ]; then
      umask 077
      POSTGRES_PASSWORD="$(openssl rand -hex 32)"
      cat > /opt/managed-oss/config/runtime.env <<EOF
    POSTGRES_PASSWORD=$${POSTGRES_PASSWORD}
    EOF
    fi
    access_secret() {
      local secret_name="$1"
      local access_token
      access_token="$(curl -fsS -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | jq -r .access_token)"
      curl -fsS -H "Authorization: Bearer $${access_token}" "https://secretmanager.googleapis.com/v1/projects/${var.project_id}/secrets/$${secret_name}/versions/latest:access" | jq -r .payload.data | base64 -d
    }
    umask 077
    cat > /opt/managed-oss/config/billing.env <<EOF
    STRIPE_SECRET_KEY=
    STRIPE_PUBLISHABLE_KEY=${var.stripe_publishable_key}
    STRIPE_WEBHOOK_SECRET=
    BILLING_MODE=disabled
    EOF
    ${var.billing_mode == "live" ? "STRIPE_SECRET_KEY=\"$(access_secret '${var.stripe_secret_name}')\"\nSTRIPE_WEBHOOK_SECRET=\"$(access_secret '${var.stripe_webhook_secret_name}')\"\ncat > /opt/managed-oss/config/billing.env <<EOF\nSTRIPE_SECRET_KEY=$${STRIPE_SECRET_KEY}\nSTRIPE_PUBLISHABLE_KEY=${var.stripe_publishable_key}\nSTRIPE_WEBHOOK_SECRET=$${STRIPE_WEBHOOK_SECRET}\nBILLING_MODE=live\nEOF" : ""}
    BACKUP_KEY_HEX="$(access_secret '${var.backup_key_secret_name}')"
    cat > /opt/managed-oss/config/worker.env <<EOF
    BACKUP_KEY_HEX=$${BACKUP_KEY_HEX}
    BACKUP_BUCKET=${var.backup_bucket}
    EOF
    touch /opt/managed-oss/config/apps.caddy
    cat > /opt/managed-oss/config/docker-compose.yml <<'EOF'
    version: "3.9"
    services:
      database:
        image: postgres:17-alpine
        restart: unless-stopped
        env_file: runtime.env
        environment:
          POSTGRES_DB: opendock
          POSTGRES_USER: opendock
          POSTGRES_PASSWORD: $${POSTGRES_PASSWORD}
        volumes:
          - /opt/managed-oss/apps/postgres:/var/lib/postgresql/data
        healthcheck:
          test: ["CMD-SHELL", "pg_isready -U opendock -d opendock"]
          interval: 10s
          timeout: 5s
          retries: 10
      control-plane:
        image: ${var.control_plane_image}
        restart: unless-stopped
        user: node
        read_only: true
        tmpfs:
          - /tmp:size=16m,mode=1777
        security_opt:
          - no-new-privileges:true
        cap_drop:
          - ALL
        depends_on:
          database:
            condition: service_healthy
        env_file:
          - runtime.env
          - billing.env
        environment:
          PORT: 8787
          DATABASE_URL: postgresql://opendock:$${POSTGRES_PASSWORD}@database:5432/opendock
          DATABASE_SSL: "false"
          PUBLIC_APP_URL: ${var.control_plane_domain != "" ? "https://${var.control_plane_domain}" : "http://${google_compute_address.managed_oss.address}"}
          PUBLIC_HOST_TARGET: ${var.apps_domain}
          PLATFORM_IPV4: ${google_compute_address.managed_oss.address}
          PROVISIONING_MODE: ${var.provisioning_mode}
        expose:
          - "8787"
      provisioning-worker:
        image: ${var.control_plane_image}
        restart: unless-stopped
        command: ["npm", "run", "worker"]
        depends_on:
          database:
            condition: service_healthy
        env_file:
          - runtime.env
          - worker.env
        environment:
          DATABASE_URL: postgresql://opendock:$${POSTGRES_PASSWORD}@database:5432/opendock
          DATABASE_SSL: "false"
          PROVISIONING_WORKER: ${var.provisioning_worker}
          HOST_APPS_ROOT: /opt/managed-oss/apps/workspaces
          HOST_CADDY_CONFIG: /opt/managed-oss/config/apps.caddy
          PLATFORM_DOCKER_NETWORK: config_default
          PLATFORM_CADDY_CONTAINER: config_caddy_1
        volumes:
          - /var/run/docker.sock:/var/run/docker.sock
          - /opt/managed-oss/apps:/opt/managed-oss/apps
          - /opt/managed-oss/config:/opt/managed-oss/config
        profiles:
          - ${var.provisioning_worker == "docker" ? "worker" : "disabled-worker"}
      caddy:
        image: caddy:2.10-alpine
        restart: unless-stopped
        ports:
          - "80:80"
          - "443:443"
        volumes:
          - /opt/managed-oss/config/Caddyfile:/etc/caddy/Caddyfile:ro
          - /opt/managed-oss/config/apps.caddy:/etc/caddy/apps.caddy:ro
          - /opt/managed-oss/apps/caddy-data:/data
          - /opt/managed-oss/apps/caddy-config:/config
    EOF
    cat > /opt/managed-oss/config/Caddyfile <<'EOF'
    ${var.control_plane_domain != "" ? var.control_plane_domain : ":80"} {
      encode zstd gzip
      reverse_proxy control-plane:8787
    }
    import /etc/caddy/apps.caddy
    EOF
    cd /opt/managed-oss/config
    set -a
    source runtime.env
    set +a
    docker-compose pull
    COMPOSE_PROFILES=${var.provisioning_worker == "docker" ? "worker" : ""} docker-compose up -d
    touch /opt/managed-oss/.host-ready
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
  }
}
