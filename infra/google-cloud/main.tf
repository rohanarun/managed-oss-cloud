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
    apt-get install -y docker.io docker-compose ca-certificates curl
    systemctl enable --now docker
    install -d -m 0750 /opt/managed-oss/apps /opt/managed-oss/backups /opt/managed-oss/config
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
