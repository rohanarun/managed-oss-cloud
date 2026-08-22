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
  value       = "The control plane and each private worker are billed independently. Increase worker_count only when reserved tenant capacity requires it."
}

output "dashboard_url" {
  description = "Open the control plane after first boot and DNS setup."
  value       = var.control_plane_domain != "" ? "https://${var.control_plane_domain}" : "http://${google_compute_address.managed_oss.address}"
}

output "worker_private_addresses" {
  description = "Private ingress addresses used only by the control-plane gateway."
  value       = { for worker in google_compute_instance.worker : worker.name => worker.network_interface[0].network_ip }
}

output "capacity_model" {
  description = "Advertised tenant capacity; placement also reserves per-app CPU and memory."
  value = {
    worker_count             = var.worker_count
    worker_machine_type      = var.worker_machine_type
    memory_mb_per_worker     = var.worker_capacity_memory_mb
    cpu_millis_per_worker    = var.worker_capacity_cpu_millis
    system_reserve_memory_mb = var.worker_system_reserve_memory_mb
  }
}
