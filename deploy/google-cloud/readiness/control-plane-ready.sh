#!/usr/bin/env bash
set -Eeuo pipefail
set +x

compose_dir="${MANAGED_OSS_COMPOSE_DIR:-/opt/managed-oss/config}"
ready_marker="${MANAGED_OSS_READY_MARKER:-/opt/managed-oss/.host-ready}"
timeout_seconds="${MANAGED_OSS_READY_TIMEOUT_SECONDS:-600}"
expected_mode="${EXPECTED_PROVISIONING_MODE:-}"
docker_bin="${DOCKER_BIN:-docker}"
compose_bin="${COMPOSE_BIN:-docker-compose}"
sleep_bin="${SLEEP_BIN:-sleep}"
metadata_firewall_proof_file="${MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE:-}"

[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
  printf 'Control-plane readiness timeout must be a positive integer.\n' >&2
  exit 2
}
[[ "$expected_mode" == "dry-run" || "$expected_mode" == "live" ]] || {
  printf 'EXPECTED_PROVISIONING_MODE must be dry-run or live.\n' >&2
  exit 2
}
[[ -d "$compose_dir" && -f "$compose_dir/docker-compose.yml" && -f "$compose_dir/runtime.env" ]] || {
  printf 'Control-plane Compose configuration is incomplete.\n' >&2
  exit 2
}

rm -f -- "$ready_marker"

hosting_entitlement_mode="$(awk -F= '$1 == "HOSTING_ENTITLEMENT_MODE" { sub(/^[^=]*=/, ""); print; exit }' "$compose_dir/runtime.env" 2>/dev/null || true)"
if [[ "$hosting_entitlement_mode" == "hosted" && -z "$metadata_firewall_proof_file" ]]; then
  printf 'Hosted control-plane readiness requires a current metadata firewall proof.\n' >&2
  exit 2
fi

if [[ -n "$metadata_firewall_proof_file" ]]; then
  [[ "$metadata_firewall_proof_file" == /* && -f "$metadata_firewall_proof_file" && ! -L "$metadata_firewall_proof_file" ]] || {
    printf 'Control-plane metadata firewall proof is unavailable.\n' >&2
    exit 2
  }
  jq -e '
    type == "object" and
    .ok == true and
    .hostMetadata == true and
    .bridgeIpv4Blocked == true and
    .bridgeIpv6Blocked == true
  ' "$metadata_firewall_proof_file" >/dev/null || {
    printf 'Control-plane metadata firewall proof is invalid.\n' >&2
    exit 2
  }
fi

compose() {
  (
    cd -- "$compose_dir"
    "$compose_bin" "$@"
  )
}

container_state() {
  local service="$1"
  local format="$2"
  local container_id
  container_id="$(compose ps -q "$service" 2>/dev/null)"
  [[ -n "$container_id" ]] || return 1
  "$docker_bin" inspect --format "$format" "$container_id" 2>/dev/null
}

api_ready() {
  compose exec -T control-plane node --input-type=module -e '
    const expectedMode = process.argv[1];
    const response = await fetch("http://127.0.0.1:8787/api/health", { signal: AbortSignal.timeout(5000) });
    const payload = await response.json();
    if (!response.ok || payload.ok !== true || payload.persistence !== "postgres" || payload.mode !== expectedMode) process.exit(1);
  ' "$expected_mode" >/dev/null 2>&1
}

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  database_health="$(container_state database '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' || true)"
  control_plane_health="$(container_state control-plane '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' || true)"
  caddy_state="$(container_state caddy '{{.State.Status}}' || true)"
  gateway_state="$(container_state gateway-reconciler '{{.State.Status}}' || true)"
  if [[ "$database_health" == "healthy" && "$control_plane_health" == "healthy" && "$caddy_state" == "running" && "$gateway_state" == "running" ]] && api_ready; then
    touch -- "$ready_marker"
    printf 'Control plane is healthy with current PostgreSQL migrations and API mode %s.\n' "$expected_mode"
    exit 0
  fi
  "$sleep_bin" 2
done

printf 'Control plane did not become healthy within %s seconds; readiness marker was withheld.\n' "$timeout_seconds" >&2
exit 1
