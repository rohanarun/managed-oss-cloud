#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readiness_dir="$(cd -- "$script_dir/.." && pwd -P)"
repo_root="$(cd -- "$readiness_dir/../../.." && pwd -P)"
control_script="$readiness_dir/control-plane-ready.sh"
worker_script="$readiness_dir/worker-ready.sh"
metadata_firewall_script="$repo_root/deploy/google-cloud/worker/metadata-firewall.sh"
metadata_firewall_proof_script="$repo_root/deploy/google-cloud/metadata-firewall-proof.sh"
main_tf="$repo_root/infra/google-cloud/main.tf"
variables_tf="$repo_root/infra/google-cloud/variables.tf"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local expected="$2"
  grep -F -- "$expected" "$file" >/dev/null || fail "$file is missing contract: $expected"
}

bash -n "$control_script"
bash -n "$worker_script"
bash -n "$metadata_firewall_script"
bash -n "$metadata_firewall_proof_script"

test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
compose_dir="$test_root/config"
mock_dir="$test_root/mock-bin"
mkdir -p "$compose_dir" "$mock_dir" "$test_root/agent"
printf 'version: "3.9"\n' > "$compose_dir/docker-compose.yml"
printf 'PROVISIONING_MODE=dry-run\n' > "$compose_dir/runtime.env"
printf 'WORKER_NODE_ID=worker-0\n' > "$compose_dir/worker.env"
printf 'agent-token\n' > "$test_root/agent/token"
metadata_proof="$test_root/control-plane-metadata-proof.json"
printf '%s\n' '{"ok":true,"hostMetadata":true,"bridgeIpv4Blocked":true,"bridgeIpv6Blocked":true}' > "$metadata_proof"

printf '%s\n' '#!/usr/bin/env bash
case "$*" in
  "ps -q database") printf "database-id\\n" ;;
  "ps -q control-plane") printf "control-plane-id\\n" ;;
  "ps -q gateway-reconciler") printf "gateway-id\\n" ;;
  "ps -q agent") printf "agent-id\\n" ;;
  "ps -q caddy") printf "caddy-id\\n" ;;
  *"exec -T control-plane node"*) [[ "${MOCK_API_FAIL:-0}" == "0" ]] ;;
  *) exit 1 ;;
esac' > "$mock_dir/docker-compose"

printf '%s\n' '#!/usr/bin/env bash
container_id="${@: -1}"
case "$container_id" in
  database-id|control-plane-id) printf "healthy\\n" ;;
  gateway-id|agent-id|caddy-id) printf "running\\n" ;;
  *) exit 1 ;;
esac' > "$mock_dir/docker"

printf '%s\n' '#!/usr/bin/env bash
url="${@: -1}"
case "$url" in
  */api/health) printf "%s\\n" "{\"ok\":true,\"persistence\":\"postgres\"}" ;;
  */api/agent/activity)
    printf "%s\\n" "{\"activity\":{\"node\":{\"id\":\"worker-0\",\"privateAddress\":\"10.70.0.3\",\"status\":\"ready\",\"lastHeartbeatAt\":\"2026-08-24T12:00:00.000Z\"},\"mode\":\"active\"}}"
    ;;
  *) exit 1 ;;
esac' > "$mock_dir/curl"

printf '%s\n' '#!/usr/bin/env bash
if [[ "${MOCK_STALE_HEARTBEAT:-0}" == "1" ]]; then printf "50\\n"; else printf "200\\n"; fi' > "$mock_dir/date"
printf '%s\n' '#!/usr/bin/env bash
[[ "$1" == "verify-host" && "$2" == "--root" && "$4" == "--capacity-bytes" ]] || exit 1
printf "%s\\n" "{\"ok\":true,\"backend\":\"operator-project-quota\",\"root\":\"$3\",\"capacityBytes\":$5,\"evidence\":\"verified-project-quota-host\"}"' > "$mock_dir/quota-helper"
chmod 0755 "$mock_dir"/*

control_marker="$test_root/host-ready"
EXPECTED_PROVISIONING_MODE=dry-run \
MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
MANAGED_OSS_READY_MARKER="$control_marker" \
MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof" \
MANAGED_OSS_READY_TIMEOUT_SECONDS=2 \
DOCKER_BIN="$mock_dir/docker" \
COMPOSE_BIN="$mock_dir/docker-compose" \
"$control_script" >/dev/null
[[ -f "$control_marker" ]] || fail "healthy control plane did not create its readiness marker"

printf '%s\n' '{"ok":true,"hostMetadata":true,"bridgeIpv4Blocked":true,"bridgeIpv6Blocked":false}' > "$metadata_proof"
set +e
EXPECTED_PROVISIONING_MODE=dry-run \
MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
MANAGED_OSS_READY_MARKER="$control_marker" \
MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof" \
MANAGED_OSS_READY_TIMEOUT_SECONDS=2 \
DOCKER_BIN="$mock_dir/docker" \
COMPOSE_BIN="$mock_dir/docker-compose" \
"$control_script" >/dev/null 2>&1
invalid_metadata_status=$?
set -e
(( invalid_metadata_status != 0 )) || fail "invalid metadata-firewall proof unexpectedly passed control-plane readiness"
[[ ! -e "$control_marker" ]] || fail "invalid metadata-firewall proof left a stale control-plane readiness marker"
printf '%s\n' '{"ok":true,"hostMetadata":true,"bridgeIpv4Blocked":true,"bridgeIpv6Blocked":true}' > "$metadata_proof"

set +e
control_failure="$(
  MOCK_API_FAIL=1 \
  EXPECTED_PROVISIONING_MODE=dry-run \
  MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
  MANAGED_OSS_READY_MARKER="$control_marker" \
  MANAGED_OSS_READY_TIMEOUT_SECONDS=1 \
  DOCKER_BIN="$mock_dir/docker" \
  COMPOSE_BIN="$mock_dir/docker-compose" \
  "$control_script" 2>&1
)"
control_status=$?
set -e
(( control_status != 0 )) || fail "unhealthy control-plane API unexpectedly passed readiness"
[[ ! -e "$control_marker" ]] || fail "failed control-plane readiness left a stale marker"
[[ "$control_failure" == *"readiness marker was withheld"* ]] || fail "control-plane failure did not explain the withheld marker"

worker_marker="$test_root/worker-ready"
worker_secret="agent-token-that-must-not-appear-in-output"
worker_output="$(
  CONTROL_PLANE_AGENT_URL=https://control.example.com \
  WORKER_NODE_ID=worker-0 \
  WORKER_PRIVATE_ADDRESS=10.70.0.3 \
  WORKER_AGENT_TOKEN_FILE="$test_root/agent/token" \
  WORKER_READINESS_NOT_BEFORE_EPOCH=100 \
  MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof" \
  MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
  MANAGED_OSS_READY_MARKER="$worker_marker" \
  MANAGED_OSS_READY_TIMEOUT_SECONDS=2 \
  DOCKER_BIN="$mock_dir/docker" \
  COMPOSE_BIN="$mock_dir/docker-compose" \
  CURL_BIN="$mock_dir/curl" \
  DATE_BIN="$mock_dir/date" \
  "$worker_script"
)"
[[ -f "$worker_marker" ]] || fail "fresh enrolled worker did not create its readiness marker"
[[ "$worker_output" != *"$worker_secret"* ]] || fail "worker readiness output exposed the bootstrap token"

hard_quota_marker="$test_root/worker-hard-quota-ready"
CONTROL_PLANE_AGENT_URL=https://control.example.com \
WORKER_NODE_ID=worker-0 \
WORKER_PRIVATE_ADDRESS=10.70.0.3 \
WORKER_AGENT_TOKEN_FILE="$test_root/agent/token" \
WORKER_READINESS_NOT_BEFORE_EPOCH=100 \
MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof" \
WORKER_STORAGE_QUOTA_BACKEND=operator-project-quota \
WORKER_STORAGE_QUOTA_PROOF_COMPLETED=true \
WORKER_STORAGE_QUOTA_HELPER="$mock_dir/quota-helper" \
WORKER_CAPACITY_STORAGE_GB=180 \
HOST_APPS_ROOT="$test_root/workspaces" \
MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
MANAGED_OSS_READY_MARKER="$hard_quota_marker" \
MANAGED_OSS_READY_TIMEOUT_SECONDS=2 \
DOCKER_BIN="$mock_dir/docker" \
COMPOSE_BIN="$mock_dir/docker-compose" \
CURL_BIN="$mock_dir/curl" \
DATE_BIN="$mock_dir/date" \
"$worker_script" >/dev/null
[[ -f "$hard_quota_marker" ]] || fail "verified hard-quota worker did not create its readiness marker"

set +e
WORKER_STORAGE_QUOTA_BACKEND=operator-project-quota \
WORKER_STORAGE_QUOTA_PROOF_COMPLETED=false \
WORKER_STORAGE_QUOTA_HELPER="$mock_dir/quota-helper" \
WORKER_CAPACITY_STORAGE_GB=180 \
CONTROL_PLANE_AGENT_URL=https://control.example.com \
WORKER_NODE_ID=worker-0 \
WORKER_PRIVATE_ADDRESS=10.70.0.3 \
WORKER_AGENT_TOKEN_FILE="$test_root/agent/token" \
WORKER_READINESS_NOT_BEFORE_EPOCH=100 \
MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof" \
MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
MANAGED_OSS_READY_MARKER="$hard_quota_marker" \
MANAGED_OSS_READY_TIMEOUT_SECONDS=1 \
DOCKER_BIN="$mock_dir/docker" \
COMPOSE_BIN="$mock_dir/docker-compose" \
CURL_BIN="$mock_dir/curl" \
DATE_BIN="$mock_dir/date" \
"$worker_script" >/dev/null 2>&1
hard_quota_status=$?
set -e
(( hard_quota_status != 0 )) || fail "unproved hard-quota worker unexpectedly passed readiness"
[[ ! -e "$hard_quota_marker" ]] || fail "failed hard-quota readiness left a stale marker"

set +e
worker_failure="$(
  MOCK_STALE_HEARTBEAT=1 \
  CONTROL_PLANE_AGENT_URL=https://control.example.com \
  WORKER_NODE_ID=worker-0 \
  WORKER_PRIVATE_ADDRESS=10.70.0.3 \
  WORKER_AGENT_TOKEN_FILE="$test_root/agent/token" \
  WORKER_READINESS_NOT_BEFORE_EPOCH=100 \
  MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof" \
  MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
  MANAGED_OSS_READY_MARKER="$worker_marker" \
  MANAGED_OSS_READY_TIMEOUT_SECONDS=1 \
  DOCKER_BIN="$mock_dir/docker" \
  COMPOSE_BIN="$mock_dir/docker-compose" \
  CURL_BIN="$mock_dir/curl" \
  DATE_BIN="$mock_dir/date" \
  "$worker_script" 2>&1
)"
worker_status=$?
set -e
(( worker_status != 0 )) || fail "stale worker heartbeat unexpectedly passed readiness"
[[ ! -e "$worker_marker" ]] || fail "failed worker readiness left a stale marker"
[[ "$worker_failure" != *"$worker_secret"* ]] || fail "worker readiness failure exposed the bootstrap token"

assert_file_contains "$main_tf" 'var.billing_mode != "live" || (var.provisioning_mode == "live" && var.worker_count >= 1 && var.subscription_reconciliation_mode == "apply")'
assert_file_contains "$main_tf" 'var.billing_mode != "live" || (var.worker_storage_quota_backend == "operator-project-quota" && var.worker_storage_quota_proof_completed)'
assert_file_contains "$main_tf" 'var.worker_capacity_storage_gb + var.worker_system_reserve_storage_gb <= var.worker_disk_size_gb'
assert_file_contains "$main_tf" 'var.worker_capacity_cpu_millis + var.worker_system_reserve_cpu_millis <= var.worker_physical_cpu_millis'
assert_file_contains "$main_tf" '!var.control_plane_backup_timer_enabled || var.control_plane_restore_proof_completed'
assert_file_contains "$main_tf" '/opt/managed-oss/readiness/control-plane-ready.sh'
assert_file_contains "$main_tf" '/opt/managed-oss/readiness/worker-ready.sh'
assert_file_contains "$main_tf" '/opt/managed-oss/security/metadata-firewall-proof.sh'
assert_file_contains "$main_tf" 'MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE=/opt/managed-oss/security/control-plane-metadata-proof.json'
assert_file_contains "$main_tf" 'MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$${METADATA_PROOF}"'
assert_file_contains "$main_tf" 'GCP_WORKER_IDENTITY_AUDIENCE=https://${var.control_plane_domain}/api/agent/register'
assert_file_contains "$main_tf" 'GCP_WORKER_IDENTITY_PROJECT_ID=${var.project_id}'
assert_file_contains "$variables_tf" "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112"
assert_file_contains "$variables_tf" 'variable "control_plane_backup_timer_enabled"'
assert_file_contains "$variables_tf" 'default     = false'
[[ "$(grep -F -c 'deletion_protection = true' "$main_tf")" -eq 2 ]] || fail "both managed instance resources must enable deletion protection"
[[ "$(grep -F -c 'auto_delete = false' "$main_tf")" -eq 2 ]] || fail "both managed instance resources must retain their boot disks"
if grep -F 'touch /opt/managed-oss/.host-ready' "$main_tf" >/dev/null || grep -F 'touch /opt/managed-oss/.worker-ready' "$main_tf" >/dev/null; then
  fail "Terraform still writes an unconditional readiness marker"
fi
if grep -F 'resource "google_secret_manager_secret_iam_member" "worker_bootstrap"' "$main_tf" >/dev/null; then
  fail "private workers still receive the shared control-plane administration secret"
fi
verify_lines="$(grep -nF 'verify-control-plane-image.sh --image' "$main_tf" | cut -d: -f1)"
pull_lines="$(grep -nF 'docker-compose pull' "$main_tf" | cut -d: -f1)"
[[ "$(wc -w <<<"$verify_lines" | tr -d ' ')" == "2" && "$(wc -w <<<"$pull_lines" | tr -d ' ')" == "2" ]] || fail "both control-plane and worker startup must have one provenance gate and one image pull"
for position in 1 2; do
  verify_line="$(sed -n "${position}p" <<<"$verify_lines")"
  pull_line="$(sed -n "${position}p" <<<"$pull_lines")"
  (( verify_line < pull_line )) || fail "Terraform startup can pull a managed image before provenance verification"
done

printf 'runtime readiness contract checks passed\n'
