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

resource "google_secret_manager_secret_iam_member" "worker_bootstrap" {
  count      = var.worker_count
  project    = var.project_id
  secret_id  = var.worker_bootstrap_secret_name
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.worker[count.index].email}"
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "gateway_reconciler" {
  project    = var.project_id
  secret_id  = var.gateway_reconciler_secret_name
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
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["managed-oss-web", "managed-oss-ssh", "managed-oss-gateway"]

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
    POSTGRES_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/managed-oss/config/runtime.env)"
    cat > /opt/managed-oss/config/postgres.env <<EOF
    POSTGRES_PASSWORD=$${POSTGRES_PASSWORD}
    EOF
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
    WORKER_BOOTSTRAP_TOKEN="$(access_secret '${var.worker_bootstrap_secret_name}')"
    GATEWAY_RECONCILER_TOKEN="$(access_secret '${var.gateway_reconciler_secret_name}')"
    sed -i '/^WORKER_BOOTSTRAP_TOKEN=/d;/^GATEWAY_RECONCILER_TOKEN=/d;/^CONTROL_PLANE_DOMAIN=/d;/^PLATFORM_IPV4=/d' /opt/managed-oss/config/runtime.env
    cat >> /opt/managed-oss/config/runtime.env <<EOF
    WORKER_BOOTSTRAP_TOKEN=$${WORKER_BOOTSTRAP_TOKEN}
    GATEWAY_RECONCILER_TOKEN=$${GATEWAY_RECONCILER_TOKEN}
    CONTROL_PLANE_DOMAIN=${var.control_plane_domain}
    PLATFORM_IPV4=${google_compute_address.managed_oss.address}
    EOF
    cat > /opt/managed-oss/config/docker-compose.yml <<'EOF'
    version: "3.9"
    services:
      database:
        image: postgres:17-alpine
        restart: unless-stopped
        env_file: postgres.env
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
      gateway-reconciler:
        image: ${var.control_plane_image}
        restart: unless-stopped
        command: ["npm", "run", "gateway"]
        depends_on:
          - control-plane
          - caddy
        environment:
          GATEWAY_RECONCILER_TOKEN: $${GATEWAY_RECONCILER_TOKEN}
          GATEWAY_CONTROL_PLANE_URL: http://control-plane:8787
          CADDY_ADMIN_URL: http://caddy:2019/load
          CONTROL_PLANE_DOMAIN: $${CONTROL_PLANE_DOMAIN}
          CONTROL_PLANE_UPSTREAM: control-plane:8787
          PLATFORM_IPV4: $${PLATFORM_IPV4}
        user: node
        read_only: true
        tmpfs:
          - /tmp:size=8m,mode=1777
        security_opt:
          - no-new-privileges:true
        cap_drop:
          - ALL
      caddy:
        image: caddy:2.10-alpine
        restart: unless-stopped
        ports:
          - "80:80"
          - "443:443"
        volumes:
          - /opt/managed-oss/config/Caddyfile:/etc/caddy/Caddyfile:ro
          - /opt/managed-oss/apps/caddy-data:/data
          - /opt/managed-oss/apps/caddy-config:/config
    EOF
    cat > /opt/managed-oss/config/Caddyfile <<'EOF'
    {
      admin 0.0.0.0:2019
    }
    ${var.control_plane_domain != "" ? var.control_plane_domain : ":80"} {
      encode zstd gzip
      reverse_proxy control-plane:8787
    }
    EOF
    cd /opt/managed-oss/config
    set -a
    source runtime.env
    set +a
    docker-compose pull
    docker-compose up -d
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

resource "google_compute_instance" "worker" {
  count        = var.worker_count
  name         = "${var.instance_name}-worker-${count.index}"
  machine_type = var.worker_machine_type
  zone         = var.zone
  tags         = ["managed-oss-worker", "managed-oss-ssh"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = var.worker_disk_size_gb
      type  = "pd-balanced"
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
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose ca-certificates curl jq
    systemctl enable --now docker
    install -d -m 0750 /opt/managed-oss/apps/workspaces /opt/managed-oss/config /opt/managed-oss/agent
    docker network inspect managed-oss-worker-platform >/dev/null 2>&1 || docker network create managed-oss-worker-platform
    metadata() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"; }
    access_secret() {
      local secret_name="$1"
      local access_token
      access_token="$(metadata instance/service-accounts/default/token | jq -r .access_token)"
      curl -fsS -H "Authorization: Bearer $${access_token}" "https://secretmanager.googleapis.com/v1/projects/${var.project_id}/secrets/$${secret_name}/versions/latest:access" | jq -r .payload.data | base64 -d
    }
    WORKER_PRIVATE_ADDRESS="$(metadata instance/network-interfaces/0/ip)"
    WORKER_BOOTSTRAP_TOKEN="$(access_secret '${var.worker_bootstrap_secret_name}')"
    BACKUP_KEY_HEX="$(access_secret '${var.backup_key_secret_name}')"
    umask 077
    cat > /opt/managed-oss/config/worker.env <<EOF
    CONTROL_PLANE_AGENT_URL=https://${var.control_plane_domain}
    WORKER_BOOTSTRAP_TOKEN=$${WORKER_BOOTSTRAP_TOKEN}
    WORKER_NODE_ID=${var.instance_name}-worker-${count.index}
    WORKER_NODE_NAME=${var.instance_name}-worker-${count.index}
    WORKER_PRIVATE_ADDRESS=$${WORKER_PRIVATE_ADDRESS}
    WORKER_MACHINE_TYPE=${var.worker_machine_type}
    WORKER_CAPACITY_MEMORY_MB=${var.worker_capacity_memory_mb}
    WORKER_CAPACITY_CPU_MILLIS=${var.worker_capacity_cpu_millis}
    WORKER_SYSTEM_RESERVE_MEMORY_MB=${var.worker_system_reserve_memory_mb}
    BACKUP_KEY_HEX=$${BACKUP_KEY_HEX}
    BACKUP_BUCKET=${var.backup_bucket}
    EOF
    touch /opt/managed-oss/config/apps.caddy
    cat > /opt/managed-oss/config/worker-Caddyfile <<'EOF'
    {
      admin 0.0.0.0:2019
      auto_https off
    }
    :8080 {
      respond "Route unavailable" 404
    }
    import /etc/caddy/apps.caddy
    EOF
    cat > /opt/managed-oss/config/docker-compose.yml <<'EOF'
    version: "3.9"
    services:
      agent:
        image: ${var.control_plane_image}
        restart: unless-stopped
        command: ["npm", "run", "worker"]
        env_file: worker.env
        environment:
          PROVISIONING_WORKER: remote
          HOST_APPS_ROOT: /opt/managed-oss/apps/workspaces
          HOST_CADDY_CONFIG: /opt/managed-oss/config/apps.caddy
          PLATFORM_DOCKER_NETWORK: managed-oss-worker-platform
          PLATFORM_CADDY_CONTAINER: managed-oss-worker-caddy
          WORKER_AGENT_TOKEN_FILE: /opt/managed-oss/agent/token
        volumes:
          - /var/run/docker.sock:/var/run/docker.sock
          - /opt/managed-oss/apps:/opt/managed-oss/apps
          - /opt/managed-oss/config:/opt/managed-oss/config
          - /opt/managed-oss/agent:/opt/managed-oss/agent
        security_opt:
          - no-new-privileges:true
      caddy:
        image: caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
        container_name: managed-oss-worker-caddy
        restart: unless-stopped
        ports:
          - "8080:8080"
        networks:
          - platform
        volumes:
          - /opt/managed-oss/config/worker-Caddyfile:/etc/caddy/Caddyfile:ro
          - /opt/managed-oss/config/apps.caddy:/etc/caddy/apps.caddy:ro
          - /opt/managed-oss/apps/caddy-data:/data
          - /opt/managed-oss/apps/caddy-config:/config
    networks:
      platform:
        external: true
        name: managed-oss-worker-platform
    EOF
    cd /opt/managed-oss/config
    docker-compose pull
    docker-compose up -d
    touch /opt/managed-oss/.worker-ready
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
  }

  depends_on = [google_compute_router_nat.workers]
}
