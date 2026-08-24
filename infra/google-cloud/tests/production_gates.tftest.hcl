mock_provider "google" {}

variables {
  project_id                        = "managed-oss-test"
  control_plane_domain              = "control.example.com"
  control_plane_image               = "ghcr.io/rohanarun/managed-oss-cloud@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  control_plane_source_commit       = "0000000000000000000000000000000000000000"
  google_oauth_assertion_public_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  stripe_publishable_key            = "pk_test_configuration_only"
}

run "disabled_billing_and_backup_are_safe_defaults" {
  command = plan

  assert {
    condition     = google_compute_instance.managed_oss.deletion_protection && !google_compute_instance.managed_oss.boot_disk[0].auto_delete
    error_message = "The control-plane VM must retain deletion protection and its boot disk."
  }
}

run "live_billing_rejects_dry_run_provisioning" {
  command = plan

  variables {
    billing_mode                     = "live"
    provisioning_mode                = "dry-run"
    worker_count                     = 1
    subscription_reconciliation_mode = "apply"
  }

  expect_failures = [google_compute_instance.managed_oss]
}

run "live_billing_rejects_zero_workers" {
  command = plan

  variables {
    billing_mode                     = "live"
    provisioning_mode                = "live"
    worker_count                     = 0
    subscription_reconciliation_mode = "apply"
  }

  expect_failures = [google_compute_instance.managed_oss]
}

run "live_billing_rejects_non_apply_reconciliation" {
  command = plan

  variables {
    billing_mode                     = "live"
    provisioning_mode                = "live"
    worker_count                     = 1
    subscription_reconciliation_mode = "dry-run"
  }

  expect_failures = [google_compute_instance.managed_oss]
}

run "live_billing_accepts_atomic_production_configuration" {
  command = plan

  variables {
    billing_mode                     = "live"
    provisioning_mode                = "live"
    worker_count                     = 1
    subscription_reconciliation_mode = "apply"
  }

  assert {
    condition     = alltrue([for worker in google_compute_instance.worker : worker.deletion_protection && !worker.boot_disk[0].auto_delete])
    error_message = "Every managed worker must retain deletion protection and its boot disk."
  }
}

run "backup_timer_rejects_missing_bucket" {
  command = plan

  variables {
    backup_bucket                         = ""
    control_plane_backup_timer_enabled    = true
    control_plane_restore_proof_completed = true
  }

  expect_failures = [google_compute_instance.managed_oss]
}

run "backup_timer_rejects_missing_restore_proof" {
  command = plan

  variables {
    backup_bucket                         = "managed-oss-test-backups"
    control_plane_backup_timer_enabled    = true
    control_plane_restore_proof_completed = false
  }

  expect_failures = [google_compute_instance.managed_oss]
}

run "backup_timer_accepts_explicit_restore_proof" {
  command = plan

  variables {
    backup_bucket                         = "managed-oss-test-backups"
    control_plane_backup_timer_enabled    = true
    control_plane_restore_proof_completed = true
  }
}
