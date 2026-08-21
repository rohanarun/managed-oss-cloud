output "external_ipv4" {
  description = "Create DNS A records for application domains using this address."
  value       = google_compute_address.managed_oss.address
}

output "ssh_command" {
  description = "Connect to the host after the startup script completes."
  value       = "gcloud compute ssh ${google_compute_instance.managed_oss.name} --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap"
}

output "monthly_cost_note" {
  description = "Pricing reminder for the operator."
  value       = "Free-tier eligibility is account and usage dependent. An in-use external IPv4 is billed separately."
}
