variable "project_id" {
  description = "Google Cloud project that will own and bill the managed OSS host."
  type        = string
}

variable "region" {
  description = "Free-tier eligible region for an e2-micro host."
  type        = string
  default     = "us-west1"

  validation {
    condition     = contains(["us-west1", "us-central1", "us-east1"], var.region)
    error_message = "Choose us-west1, us-central1, or us-east1 for Compute Engine free-tier eligibility."
  }
}

variable "zone" {
  description = "Compute Engine zone within the selected region."
  type        = string
  default     = "us-west1-b"
}

variable "instance_name" {
  description = "Name for the private application host."
  type        = string
  default     = "managed-oss-host"
}

variable "machine_type" {
  description = "Control-plane machine type. Customer applications run on separate worker nodes."
  type        = string
  default     = "e2-medium"
}

variable "worker_count" {
  description = "Number of private application worker nodes. Increase horizontally as reserved capacity fills."
  type        = number
  default     = 0
  validation {
    condition     = var.worker_count >= 0 && var.worker_count <= 100
    error_message = "Worker count must be between 0 and 100."
  }
}

variable "worker_machine_type" {
  description = "Machine type for each private application worker."
  type        = string
  default     = "e2-standard-2"
}

variable "worker_disk_size_gb" {
  description = "Persistent boot disk size for each stateful application worker."
  type        = number
  default     = 40
}

variable "worker_capacity_memory_mb" {
  description = "Schedulable memory advertised by each worker. Keep below physical RAM."
  type        = number
  default     = 7168
}

variable "worker_capacity_cpu_millis" {
  description = "Schedulable CPU advertised by each worker."
  type        = number
  default     = 1800
}

variable "worker_system_reserve_memory_mb" {
  description = "Memory withheld from tenant scheduling for the OS, Docker, Caddy, and agent."
  type        = number
  default     = 768
}

variable "disk_size_gb" {
  description = "Standard persistent boot disk size. Up to 30 GB-month is included in the eligible free tier."
  type        = number
  default     = 30

  validation {
    condition     = var.disk_size_gb >= 10
    error_message = "The host needs at least a 10 GB boot disk."
  }
}

variable "control_plane_image" {
  description = "Published OpenDock control-plane container image. Pin a digest for production."
  type        = string
  default     = "ghcr.io/rohanarun/managed-oss-cloud:latest"
}

variable "control_plane_domain" {
  description = "Optional DNS hostname for the dashboard. Leave empty for HTTP on the static IPv4 during initial setup."
  type        = string
  default     = ""
}

variable "apps_domain" {
  description = "Base hostname used for planned application CNAME targets. Replace the example before production."
  type        = string
  default     = "apps.example.com"
}

variable "provisioning_mode" {
  description = "Keep dry-run until install, rollback, billing, and backup proofs pass."
  type        = string
  default     = "dry-run"
  validation {
    condition     = contains(["dry-run", "live"], var.provisioning_mode)
    error_message = "Provisioning mode must be dry-run or live."
  }
}

variable "provisioning_worker" {
  description = "Deprecated single-host worker switch retained for configuration compatibility. It must remain disabled."
  type        = string
  default     = "disabled"
  validation {
    condition     = var.provisioning_worker == "disabled"
    error_message = "The database-connected single-host worker was removed; provisioning_worker must be disabled."
  }
}

variable "billing_mode" {
  description = "Live Stripe checkout remains independently fail-closed."
  type        = string
  default     = "disabled"
  validation {
    condition     = contains(["disabled", "live"], var.billing_mode)
    error_message = "Billing mode must be disabled or live."
  }
}

variable "stripe_publishable_key" {
  description = "Stripe publishable key; this is intentionally browser-visible."
  type        = string
  default     = ""
}

variable "stripe_secret_name" {
  description = "Existing Secret Manager secret containing the Stripe secret key."
  type        = string
  default     = "managed-oss-stripe-secret-key"
}

variable "stripe_webhook_secret_name" {
  description = "Existing Secret Manager secret containing the Stripe webhook signing secret."
  type        = string
  default     = "managed-oss-stripe-webhook-secret"
}

variable "backup_bucket" {
  description = "Existing private GCS bucket for encrypted application backups."
  type        = string
  default     = ""
}

variable "backup_key_secret_name" {
  description = "Existing Secret Manager secret containing a 32-byte hex backup key."
  type        = string
  default     = "managed-oss-backup-key"
}

variable "worker_bootstrap_secret_name" {
  description = "Existing Secret Manager secret used once by private workers to obtain agent credentials."
  type        = string
  default     = "managed-oss-worker-bootstrap-token"
}

variable "gateway_reconciler_secret_name" {
  description = "Existing Secret Manager secret authenticating the ingress route reconciler."
  type        = string
  default     = "managed-oss-gateway-reconciler-token"
}
