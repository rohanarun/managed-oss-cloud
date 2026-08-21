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

  metadata_startup_script = <<-STARTUP
    #!/usr/bin/env bash
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose ca-certificates curl openssl
    systemctl enable --now docker
    install -d -m 0750 /opt/managed-oss/apps /opt/managed-oss/backups /opt/managed-oss/config
    if [ ! -f /opt/managed-oss/config/runtime.env ]; then
      umask 077
      POSTGRES_PASSWORD="$(openssl rand -hex 32)"
      cat > /opt/managed-oss/config/runtime.env <<EOF
    POSTGRES_PASSWORD=$${POSTGRES_PASSWORD}
    EOF
    fi
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
        depends_on:
          database:
            condition: service_healthy
        env_file: runtime.env
        environment:
          PORT: 8787
          DATABASE_URL: postgresql://opendock:$${POSTGRES_PASSWORD}@database:5432/opendock
          DATABASE_SSL: "false"
          PUBLIC_APP_URL: ${var.control_plane_domain != "" ? "https://${var.control_plane_domain}" : "http://${google_compute_address.managed_oss.address}"}
          PUBLIC_HOST_TARGET: ${var.apps_domain}
          PROVISIONING_MODE: dry-run
        expose:
          - "8787"
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
