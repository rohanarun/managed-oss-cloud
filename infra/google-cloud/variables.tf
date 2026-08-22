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
  description = "Machine type. Start with e2-micro and upgrade when capacity requires it."
  type        = string
  default     = "e2-micro"
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
  description = "Enable the isolated Docker worker only after production validation."
  type        = string
  default     = "disabled"
  validation {
    condition     = contains(["disabled", "docker"], var.provisioning_worker)
    error_message = "Provisioning worker must be disabled or docker."
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
