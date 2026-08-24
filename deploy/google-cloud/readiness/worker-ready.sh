#!/usr/bin/env bash
set -Eeuo pipefail
set +x

compose_dir="${MANAGED_OSS_COMPOSE_DIR:-/opt/managed-oss/config}"
ready_marker="${MANAGED_OSS_READY_MARKER:-/opt/managed-oss/.worker-ready}"
timeout_seconds="${MANAGED_OSS_READY_TIMEOUT_SECONDS:-600}"
not_before_epoch="${WORKER_READINESS_NOT_BEFORE_EPOCH:-}"
agent_token_file="${WORKER_AGENT_TOKEN_FILE:-/opt/managed-oss/agent/token}"
control_plane_url="${CONTROL_PLANE_AGENT_URL:-}"
worker_node_id="${WORKER_NODE_ID:-}"
worker_private_address="${WORKER_PRIVATE_ADDRESS:-}"
docker_bin="${DOCKER_BIN:-docker}"
compose_bin="${COMPOSE_BIN:-docker-compose}"
curl_bin="${CURL_BIN:-curl}"
jq_bin="${JQ_BIN:-jq}"
date_bin="${DATE_BIN:-date}"
sleep_bin="${SLEEP_BIN:-sleep}"
apps_root="${HOST_APPS_ROOT:-/opt/managed-oss/apps/workspaces}"
quota_backend="${WORKER_STORAGE_QUOTA_BACKEND:-measurement-only}"
quota_proof_completed="${WORKER_STORAGE_QUOTA_PROOF_COMPLETED:-false}"
quota_helper="${WORKER_STORAGE_QUOTA_HELPER:-}"
capacity_storage_gb="${WORKER_CAPACITY_STORAGE_GB:-}"
metadata_firewall_proof_file="${MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE:-}"

[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
  printf 'Worker readiness timeout must be a positive integer.\n' >&2
  exit 2
}
[[ "$not_before_epoch" =~ ^[1-9][0-9]*$ ]] || {
  printf 'WORKER_READINESS_NOT_BEFORE_EPOCH must be a positive Unix timestamp.\n' >&2
  exit 2
}
[[ "$control_plane_url" == https://* && -n "$worker_node_id" && -n "$worker_private_address" ]] || {
  printf 'Worker enrollment readiness settings are incomplete.\n' >&2
  exit 2
}
[[ -d "$compose_dir" && -f "$compose_dir/docker-compose.yml" && -f "$compose_dir/worker.env" ]] || {
  printf 'Worker Compose configuration is incomplete.\n' >&2
  exit 2
}
[[ "$quota_backend" == "measurement-only" || "$quota_backend" == "operator-project-quota" ]] || {
  printf 'Worker storage quota backend is invalid.\n' >&2
  exit 2
}

rm -f -- "$ready_marker"

[[ "$metadata_firewall_proof_file" == /* && -f "$metadata_firewall_proof_file" && ! -L "$metadata_firewall_proof_file" ]] || {
  printf 'Worker metadata firewall proof is unavailable.\n' >&2
  exit 2
}
"$jq_bin" -e '
  type == "object" and
  .ok == true and
  .hostMetadata == true and
  .bridgeIpv4Blocked == true and
  .bridgeIpv6Blocked == true
' "$metadata_firewall_proof_file" >/dev/null || {
  printf 'Worker metadata firewall proof is invalid.\n' >&2
  exit 2
}

compose() {
  (
    cd -- "$compose_dir"
    "$compose_bin" "$@"
  )
}

container_running() {
  local service="$1"
  local container_id
  container_id="$(compose ps -q "$service" 2>/dev/null)"
  [[ -n "$container_id" ]] || return 1
  [[ "$("$docker_bin" inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null)" == "running" ]]
}

control_plane_healthy() {
  "$curl_bin" -fsS --max-time 5 "${control_plane_url%/}/api/health" 2>/dev/null \
    | "$jq_bin" -e '.ok == true and .persistence == "postgres"' >/dev/null 2>&1
}

worker_enrolled() {
  local activity heartbeat heartbeat_epoch agent_token
  agent_token="$(<"$agent_token_file")"
  [[ -n "$agent_token" ]] || return 1
  activity="$("$curl_bin" -fsS --max-time 5 \
    -H "Authorization: Bearer $agent_token" \
    "${control_plane_url%/}/api/agent/activity" 2>/dev/null)" || return 1
  "$jq_bin" -e --arg node_id "$worker_node_id" --arg private_address "$worker_private_address" '
    .activity.node.id == $node_id and
    .activity.node.privateAddress == $private_address and
    .activity.node.status == "ready" and
    .activity.mode == "active" and
    (.activity.node.lastHeartbeatAt | type == "string" and length > 0)
  ' <<<"$activity" >/dev/null 2>&1 || return 1
  heartbeat="$("$jq_bin" -r '.activity.node.lastHeartbeatAt' <<<"$activity")"
  heartbeat_epoch="$("$date_bin" --date="$heartbeat" +%s 2>/dev/null)" || return 1
  [[ "$heartbeat_epoch" =~ ^[0-9]+$ && "$heartbeat_epoch" -ge "$not_before_epoch" ]]
}

hard_quota_ready() {
  local proof capacity_bytes
  [[ "$quota_backend" == "operator-project-quota" ]] || return 0
  [[ "$quota_proof_completed" == "true" && "$capacity_storage_gb" =~ ^[1-9][0-9]*$ && "$quota_helper" == /* && -x "$quota_helper" ]] || return 1
  capacity_bytes=$((capacity_storage_gb * 1000000000))
  proof="$("$quota_helper" verify-host --root "$apps_root" --capacity-bytes "$capacity_bytes" 2>/dev/null)" || return 1
  "$jq_bin" -e --arg root "$apps_root" --argjson capacity_bytes "$capacity_bytes" '
    .ok == true and
    .backend == "operator-project-quota" and
    .root == $root and
    .capacityBytes == $capacity_bytes and
    (.evidence | type == "string" and length >= 16)
  ' <<<"$proof" >/dev/null 2>&1
}

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  if container_running agent && container_running caddy && [[ -s "$agent_token_file" ]] && control_plane_healthy && worker_enrolled && hard_quota_ready; then
    touch -- "$ready_marker"
    printf 'Worker %s is enrolled, active, and heartbeating from %s.\n' "$worker_node_id" "$worker_private_address"
    exit 0
  fi
  "$sleep_bin" 2
done

printf 'Worker %s did not complete fresh enrollment within %s seconds; readiness marker was withheld.\n' "$worker_node_id" "$timeout_seconds" >&2
exit 1
