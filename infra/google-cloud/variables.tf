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
