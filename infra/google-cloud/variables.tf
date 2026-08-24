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
    condition     = var.worker_count >= 0 && var.worker_count <= 100 && floor(var.worker_count) == var.worker_count
    error_message = "Worker count must be a whole number between 0 and 100."
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
  default     = 200
  validation {
    condition     = var.worker_disk_size_gb >= 40
    error_message = "A stateful application worker needs at least 40 GB of persistent disk."
  }
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

variable "worker_physical_cpu_millis" {
  description = "Reviewed physical CPU capacity of worker_machine_type in CPU millis. Runtime readiness independently measures the host and fails on drift."
  type        = number
  default     = 2000
  validation {
    condition     = var.worker_physical_cpu_millis >= 1000 && floor(var.worker_physical_cpu_millis) == var.worker_physical_cpu_millis
    error_message = "Worker physical CPU must be a whole number of at least 1000 millis."
  }
}

variable "worker_capacity_storage_gb" {
  description = "Schedulable persistent storage advertised by each worker. Keep below the boot disk size."
  type        = number
  default     = 180
}

variable "worker_system_reserve_memory_mb" {
  description = "Memory withheld from tenant scheduling for the OS, Docker, Caddy, and agent."
  type        = number
  default     = 768
}

variable "worker_system_reserve_cpu_millis" {
  description = "Logical CPU withheld from application scheduling for the OS, Docker, Caddy, and the worker agent."
  type        = number
  default     = 200
  validation {
    condition     = var.worker_system_reserve_cpu_millis >= 100 && floor(var.worker_system_reserve_cpu_millis) == var.worker_system_reserve_cpu_millis
    error_message = "Worker CPU reserve must be a whole number of at least 100 millis."
  }
}

variable "worker_system_reserve_storage_gb" {
  description = "Disk headroom withheld from customer reservations for images, logs, backups, and recovery operations."
  type        = number
  default     = 15
  validation {
    condition     = var.worker_system_reserve_storage_gb >= 5 && floor(var.worker_system_reserve_storage_gb) == var.worker_system_reserve_storage_gb
    error_message = "Worker storage reserve must be a whole number of at least 5 GB."
  }
}

variable "worker_storage_quota_backend" {
  description = "Per-workspace storage enforcement. measurement-only stops observed overruns but is not a hard quota; operator-project-quota requires an externally provisioned and verified filesystem project-quota helper."
  type        = string
  default     = "measurement-only"
  validation {
    condition     = contains(["measurement-only", "operator-project-quota"], var.worker_storage_quota_backend)
    error_message = "Worker storage quota backend must be measurement-only or operator-project-quota."
  }
}

variable "worker_storage_quota_proof_completed" {
  description = "Operator acknowledgement that the hard project-quota backend was exercised on every worker with exact-path and exact-byte-limit proof. Required before live billing."
  type        = bool
  default     = false
}

variable "worker_storage_quota_helper" {
  description = "Absolute in-agent path to the independently provisioned hard project-quota helper. It is intentionally not downloaded by Terraform."
  type        = string
  default     = "/opt/managed-oss/quota/bin/managed-project-quota"
  validation {
    condition     = can(regex("^/[A-Za-z0-9._/-]+$", var.worker_storage_quota_helper))
    error_message = "Worker storage quota helper must be an absolute safe path."
  }
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
  description = "Published control-plane container image pinned to an immutable sha256 digest."
  type        = string
  validation {
    condition     = can(regex("^ghcr\\.io/rohanarun/managed-oss-cloud@sha256:[0-9a-f]{64}$", var.control_plane_image))
    error_message = "control_plane_image must be the exact approved ghcr.io/rohanarun/managed-oss-cloud repository pinned with @sha256:<64 lowercase hex characters>."
  }
}

variable "control_plane_source_commit" {
  description = "Reviewed lowercase 40-character Git commit that built and attested control_plane_image. The provenance gate requires an exact match before any image pull."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.control_plane_source_commit))
    error_message = "control_plane_source_commit must be an exact lowercase 40-character Git commit."
  }
}

variable "github_cli_version" {
  description = "Reviewed immutable GitHub CLI release used only for OCI build-provenance verification."
  type        = string
  default     = "2.97.0"
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.github_cli_version))
    error_message = "github_cli_version must be a numeric semantic version."
  }
}

variable "github_cli_linux_amd64_sha256" {
  description = "Reviewed SHA-256 for gh_VERSION_linux_amd64.tar.gz from the immutable GitHub CLI release."
  type        = string
  default     = "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112"
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.github_cli_linux_amd64_sha256))
    error_message = "github_cli_linux_amd64_sha256 must be an exact lowercase SHA-256 digest."
  }
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

variable "subscription_reconciliation_mode" {
  description = "Scheduled Stripe reconciliation. Start with dry-run; apply mutates only after a reviewed provider/database comparison."
  type        = string
  default     = "disabled"
  validation {
    condition     = contains(["disabled", "dry-run", "apply"], var.subscription_reconciliation_mode)
    error_message = "Subscription reconciliation mode must be disabled, dry-run, or apply."
  }
}

variable "subscription_reconciliation_interval_milliseconds" {
  description = "Delay between scheduled Stripe reconciliation passes."
  type        = number
  default     = 900000
  validation {
    condition     = var.subscription_reconciliation_interval_milliseconds >= 60000 && var.subscription_reconciliation_interval_milliseconds <= 86400000
    error_message = "Subscription reconciliation interval must be between 60000 and 86400000 milliseconds."
  }
}

variable "startup_readiness_timeout_seconds" {
  description = "Maximum time startup waits for control-plane health or worker enrollment before withholding the readiness marker."
  type        = number
  default     = 600
  validation {
    condition     = floor(var.startup_readiness_timeout_seconds) == var.startup_readiness_timeout_seconds && var.startup_readiness_timeout_seconds >= 60 && var.startup_readiness_timeout_seconds <= 1800
    error_message = "Startup readiness timeout must be a whole number between 60 and 1800 seconds."
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

variable "stripe_secret_version" {
  description = "Pinned enabled Secret Manager version containing the Stripe secret key."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.stripe_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "stripe_webhook_secret_name" {
  description = "Existing Secret Manager secret containing the Stripe webhook signing secret."
  type        = string
  default     = "managed-oss-stripe-webhook-secret"
}

variable "stripe_webhook_secret_version" {
  description = "Pinned enabled Secret Manager version containing the Stripe webhook signing secret."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.stripe_webhook_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "backup_bucket" {
  description = "Existing private GCS bucket for encrypted application backups."
  type        = string
  default     = ""
}

variable "control_plane_backup_timer_enabled" {
  description = "Explicitly enable the daily control-plane PostgreSQL backup timer. It remains off by default and cannot be enabled before restore proof is acknowledged."
  type        = bool
  default     = false
}

variable "control_plane_restore_proof_completed" {
  description = "Operator acknowledgement that the first control-plane backup completed and was successfully restored and validated in an isolated verification database."
  type        = bool
  default     = false
}

variable "backup_key_secret_name" {
  description = "Existing Secret Manager secret containing a 32-byte hex backup key."
  type        = string
  default     = "managed-oss-backup-key"
}

variable "backup_key_secret_version" {
  description = "Pinned enabled Secret Manager version containing the worker backup encryption key."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.backup_key_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "worker_bootstrap_secret_name" {
  description = "Existing Secret Manager secret used only by control-plane operators for worker drain and activity administration. Private workers enroll with Google-signed instance identity documents and cannot access this secret."
  type        = string
  default     = "managed-oss-worker-bootstrap-token"
}

variable "worker_bootstrap_secret_version" {
  description = "Pinned enabled Secret Manager version containing the control-plane worker administration token."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.worker_bootstrap_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "gateway_reconciler_secret_name" {
  description = "Existing Secret Manager secret authenticating the ingress route reconciler."
  type        = string
  default     = "managed-oss-gateway-reconciler-token"
}

variable "gateway_reconciler_secret_version" {
  description = "Pinned enabled Secret Manager version containing the gateway reconciler token."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.gateway_reconciler_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "consent_policy_signing_secret_name" {
  description = "Existing Secret Manager secret containing the base64 PKCS#8 Ed25519 key used to sign public consent policies and receipts."
  type        = string
  default     = "managed-oss-consent-policy-signing-key"
}

variable "consent_policy_signing_secret_version" {
  description = "Pinned enabled Secret Manager version containing the Ed25519 policy-signing key."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.consent_policy_signing_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "extended_external_evidence_secret_name" {
  description = "Existing Secret Manager secret used only by trusted hosting-layer source adapters to attest exact external payment, access, usage, and scanner evidence."
  type        = string
  default     = "managed-oss-extended-external-evidence-hmac"
}

variable "extended_external_evidence_secret_version" {
  description = "Pinned enabled Secret Manager version containing the external-evidence HMAC secret."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.extended_external_evidence_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "google_oauth_client_id_secret_name" {
  description = "Existing Secret Manager secret containing the platform-owned Google OAuth client ID."
  type        = string
  default     = "managed-oss-google-oauth-client-id"
}

variable "google_oauth_client_id_secret_version" {
  description = "Pinned enabled Secret Manager version containing the Google OAuth client ID."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.google_oauth_client_id_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "google_oauth_client_secret_secret_name" {
  description = "Existing Secret Manager secret containing the platform-owned Google OAuth client secret."
  type        = string
  default     = "managed-oss-google-oauth-client-secret"
}

variable "google_oauth_client_secret_secret_version" {
  description = "Pinned enabled Secret Manager version containing the Google OAuth client secret."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.google_oauth_client_secret_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "google_oauth_state_secret_name" {
  description = "Existing Secret Manager secret containing the platform-owned OAuth state signing secret."
  type        = string
  default     = "managed-oss-google-oauth-state-secret"
}

variable "google_oauth_state_secret_version" {
  description = "Pinned enabled Secret Manager version containing the OAuth state signing secret."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.google_oauth_state_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "google_oauth_callback_url_secret_name" {
  description = "Existing Secret Manager secret containing the exact platform OAuth callback URL."
  type        = string
  default     = "managed-oss-google-oauth-callback-url"
}

variable "google_oauth_callback_url_secret_version" {
  description = "Pinned enabled Secret Manager version containing the platform OAuth callback URL."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.google_oauth_callback_url_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "google_oauth_assertion_signing_secret_name" {
  description = "Existing Secret Manager secret containing the base64 PKCS#8 Ed25519 private key used only by the control-plane OAuth broker."
  type        = string
  default     = "managed-oss-google-oauth-assertion-signing-key"
}

variable "google_oauth_assertion_signing_secret_version" {
  description = "Pinned enabled Secret Manager version containing the OAuth assertion signing private key."
  type        = string
  default     = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.google_oauth_assertion_signing_secret_version))
    error_message = "Secret versions must be explicit positive integers, never latest."
  }
}

variable "google_oauth_assertion_public_key" {
  description = "Base64 DER SPKI Ed25519 public key matching the broker signing key. This non-secret value is the only OAuth key distributed to workers and tenant applications."
  type        = string
  validation {
    condition     = can(base64decode(var.google_oauth_assertion_public_key)) && length(base64decode(var.google_oauth_assertion_public_key)) >= 32
    error_message = "The OAuth assertion public key must be a base64 DER SPKI value."
  }
}

variable "consent_policy_previous_public_keys" {
  description = "Previously trusted public Ed25519 consent-policy keys retained during reviewed key rotation. These public keys are exposed only to the control-plane process as JSON."
  type = list(object({
    algorithm = string
    keyId     = string
    publicKey = string
  }))
  default = []
  validation {
    condition = length(var.consent_policy_previous_public_keys) <= 20 && alltrue([
      for key in var.consent_policy_previous_public_keys :
      key.algorithm == "Ed25519" &&
      can(regex("^[A-Za-z0-9_-]{24}$", key.keyId)) &&
      can(regex("^[A-Za-z0-9_-]{40,256}$", key.publicKey))
    ])
    error_message = "Previous consent-policy keys must be at most 20 Ed25519 key records with canonical base64url-shaped key IDs and public keys."
  }
  validation {
    condition     = length(distinct([for key in var.consent_policy_previous_public_keys : key.keyId])) == length(var.consent_policy_previous_public_keys)
    error_message = "Previous consent-policy key IDs must be unique."
  }
}
