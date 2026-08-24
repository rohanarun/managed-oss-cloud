#!/usr/bin/env bash
set -Eeuo pipefail
set +x

die() {
  printf 'Control-plane rollout refused: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Run a provenance-gated control-plane rollout on an existing host.

Usage:
  sudo ./rollout-control-plane.sh --source-commit 40_HEX_COMMIT \
    [--compose-dir /opt/managed-oss/config] \
    [--proof-dir /opt/managed-oss/provenance] \
    [--ready-marker /opt/managed-oss/.host-ready] \
    [--security-dir /opt/managed-oss/security] \
    [--systemd-dir /etc/systemd/system]

Update CONTROL_PLANE_IMAGE in the root-owned runtime.env first. This command
verifies that exact digest before any pull, migration, or container recreation.
EOF
}

source_commit=""
compose_dir="/opt/managed-oss/config"
proof_dir="/opt/managed-oss/provenance"
ready_marker="/opt/managed-oss/.host-ready"
security_dir="/opt/managed-oss/security"
systemd_dir="/etc/systemd/system"
while (( $# > 0 )); do
  case "$1" in
    --source-commit)
      [[ $# -ge 2 ]] || die "--source-commit requires a value"
      source_commit="$2"
      shift 2
      ;;
    --compose-dir)
      [[ $# -ge 2 ]] || die "--compose-dir requires a value"
      compose_dir="$2"
      shift 2
      ;;
    --proof-dir)
      [[ $# -ge 2 ]] || die "--proof-dir requires a value"
      proof_dir="$2"
      shift 2
      ;;
    --ready-marker)
      [[ $# -ge 2 ]] || die "--ready-marker requires a value"
      ready_marker="$2"
      shift 2
      ;;
    --security-dir)
      [[ $# -ge 2 ]] || die "--security-dir requires a value"
      security_dir="$2"
      shift 2
      ;;
    --systemd-dir)
      [[ $# -ge 2 ]] || die "--systemd-dir requires a value"
      systemd_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]] || die "--source-commit must be an exact lowercase 40-character Git commit"
[[ "$compose_dir" == /* && "$proof_dir" == /* && "$ready_marker" == /* && "$security_dir" == /* && "$systemd_dir" == /* ]] || die "deployment paths must be absolute"
[[ -d "$compose_dir" && ! -L "$compose_dir" ]] || die "Compose directory must be a non-symlink directory"
runtime_env="$compose_dir/runtime.env"
compose_file="$compose_dir/docker-compose.yml"
[[ -f "$runtime_env" && ! -L "$runtime_env" && -f "$compose_file" && ! -L "$compose_file" ]] \
  || die "runtime.env and docker-compose.yml must be regular non-symlink files"

image_count="$(awk -F= '$1 == "CONTROL_PLANE_IMAGE" { count += 1 } END { print count + 0 }' "$runtime_env")"
[[ "$image_count" == "1" ]] || die "runtime.env must contain exactly one CONTROL_PLANE_IMAGE assignment"
image="$(awk -F= '$1 == "CONTROL_PLANE_IMAGE" { sub(/^[^=]*=/, ""); print }' "$runtime_env")"
[[ "$image" =~ ^ghcr\.io/rohanarun/managed-oss-cloud@sha256:([a-f0-9]{64})$ ]] \
  || die "runtime.env CONTROL_PLANE_IMAGE is not the allowed digest-pinned image"
image_hex="${BASH_REMATCH[1]}"
provisioning_mode="$(awk -F= '$1 == "PROVISIONING_MODE" { sub(/^[^=]*=/, ""); print }' "$runtime_env")"
[[ "$provisioning_mode" == "dry-run" || "$provisioning_mode" == "live" ]] \
  || die "runtime.env PROVISIONING_MODE must be dry-run or live"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="$script_dir/provenance/verify-control-plane-image.sh"
readiness="$script_dir/readiness/control-plane-ready.sh"
database_configurator="${DATABASE_ROLE_CONFIGURATOR:-$script_dir/database/configure-role-logins.sh}"
domain_identity_preflight="$script_dir/database/preflight-migration-018-domain-identities.sql"
firewall_source="$script_dir/worker/metadata-firewall.sh"
firewall_service_source="$script_dir/worker/managed-oss-metadata-firewall.service"
firewall_drop_in_source="$script_dir/worker/docker-metadata-firewall.conf"
firewall_proof_source="$script_dir/metadata-firewall-proof.sh"
[[ -x "$verifier" && -x "$readiness" && -x "$database_configurator" && -f "$domain_identity_preflight" && ! -L "$domain_identity_preflight" && -f "$firewall_source" && -f "$firewall_service_source" && -f "$firewall_drop_in_source" && -f "$firewall_proof_source" ]] || die "trusted provenance, metadata-firewall, database-role, migration preflight, and readiness files are unavailable"
install -d -m 0750 "$proof_dir"
proof_file="$proof_dir/control-plane-${image_hex}-${source_commit}-$(date -u +%Y%m%dT%H%M%SZ).json"
metadata_proof_file="$proof_dir/control-plane-metadata-${image_hex}-$(date -u +%Y%m%dT%H%M%SZ).json"

install -d -m 0750 "$security_dir"
install -d -m 0755 "$systemd_dir/docker.service.d"
install -m 0750 "$firewall_source" "$security_dir/metadata-firewall.sh"
install -m 0750 "$firewall_proof_source" "$security_dir/metadata-firewall-proof.sh"
install -m 0644 "$firewall_service_source" "$systemd_dir/managed-oss-metadata-firewall.service"
install -m 0644 "$firewall_drop_in_source" "$systemd_dir/docker.service.d/managed-oss-metadata-firewall.conf"
systemctl_bin="${SYSTEMCTL_BIN:-systemctl}"
"$systemctl_bin" daemon-reload
"$systemctl_bin" enable --now managed-oss-metadata-firewall.service

"$verifier" \
  --image "$image" \
  --source-commit "$source_commit" \
  --proof-file "$proof_file" >/dev/null
jq -e \
  --arg image "$image" \
  --arg commit "$source_commit" \
  --arg digest "sha256:$image_hex" '
    .schemaVersion == 2 and
    .verified == true and
    .image == $image and
    .manifestDigest == $digest and
    .manifestBodyDigest == $digest and
    .repository == "rohanarun/managed-oss-cloud" and
    .signerWorkflow == "rohanarun/managed-oss-cloud/.github/workflows/container.yml" and
    .signerDigest == $commit and
    .sourceCommit == $commit and
    .predicateType == "https://slsa.dev/provenance/v1" and
    .attestationSource == "oci-registry" and
    .deniedSelfHostedRunners == true and
    (.attestationCount | type == "number" and . > 0)
  ' \
  "$proof_file" >/dev/null \
  || die "the machine-readable provenance proof did not match this rollout"

docker_bin="${DOCKER_BIN:-docker}"
"$docker_bin" pull "$image" >/dev/null
METADATA_FIREWALL_SCRIPT="$security_dir/metadata-firewall.sh" \
  DOCKER_BIN="$docker_bin" \
  "$security_dir/metadata-firewall-proof.sh" "$image" >"$metadata_proof_file"
chmod 0640 "$metadata_proof_file"
jq -e '.ok == true and .hostMetadata == true and .bridgeIpv4Blocked == true and .bridgeIpv6Blocked == true' "$metadata_proof_file" >/dev/null \
  || die "the machine-readable metadata firewall proof did not match this rollout"

compose_bin="${COMPOSE_BIN:-docker-compose}"
compose() {
  (
    cd -- "$compose_dir"
    "$compose_bin" "$@"
  )
}

set -a
source "$runtime_env"
set +a
postgres_env="$compose_dir/postgres.env"
[[ -f "$postgres_env" && ! -L "$postgres_env" ]] || die "postgres.env is required for the administrator-owned pgcrypto dependency preflight"
postgres_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$postgres_env")"
[[ "$postgres_password" =~ ^[a-f0-9]{64}$ ]] || die "postgres.env does not contain the expected generated administrator password"
if [[ ! -f "$compose_dir/database-role-passwords.env" ]]; then
  printf 'DATABASE_MIGRATOR_URL=postgresql://opendock:%s@database:5432/opendock\n' "$postgres_password" >"$compose_dir/database-migrator.env"
  chmod 0600 "$compose_dir/database-migrator.env"
fi
for service_env in database-control.env database-suite.env database-ai.env; do
  if [[ ! -f "$compose_dir/$service_env" ]]; then
    install -m 0600 /dev/null "$compose_dir/$service_env"
  fi
done
compose --profile operations pull
printf '%s\n' "$postgres_password" | compose exec -T database sh -ceu '
  IFS= read -r PGPASSWORD
  export PGPASSWORD
  psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U opendock -d opendock -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
'
domain_identity_report="$({
  printf '%s\n' "$postgres_password"
  cat -- "$domain_identity_preflight"
} | compose exec -T database sh -ceu '
  IFS= read -r PGPASSWORD
  case "$PGPASSWORD" in *[!a-f0-9]*|"") exit 64 ;; esac
  [ "${#PGPASSWORD}" -eq 64 ]
  export PGPASSWORD
  psql -X -q -v ON_ERROR_STOP=1 -A -t -F "|" -h 127.0.0.1 -U opendock -d opendock -f -
')" || die "migration 018 domain-identity duplicate preflight could not complete"
domain_identity_report_status=0
printf '%s\n' "$domain_identity_report" | awk -F '|' '
  {
    rows += 1
    if (NF != 2 || $1 !~ /^suite_[a-z0-9_]+_unique$/ || $2 !~ /^(0|[1-9][0-9]*)$/ || seen[$1]++) invalid = 1
    if ($2 != "0") duplicates = 1
  }
  END {
    unique_names = 0
    for (name in seen) unique_names += 1
    if (invalid || rows != 24 || unique_names != 24) exit 2
    if (duplicates) exit 1
  }
' || domain_identity_report_status=$?
if (( domain_identity_report_status == 2 )); then
  die "migration 018 domain-identity duplicate preflight returned an invalid privacy-safe report"
fi
printf '%s\n' "$domain_identity_report"
if (( domain_identity_report_status != 0 )); then
  die "migration 018 domain-identity duplicate preflight found duplicate groups; resolve them through an independently reviewed evidence-preserving process before rollout"
fi
postgres_password=""
compose --profile operations run --rm migrate
MANAGED_OSS_COMPOSE_DIR="$compose_dir" "$database_configurator"
rm -f -- "$ready_marker"
compose up -d --remove-orphans
EXPECTED_PROVISIONING_MODE="$provisioning_mode" \
  MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof_file" \
  MANAGED_OSS_COMPOSE_DIR="$compose_dir" \
  MANAGED_OSS_READY_MARKER="$ready_marker" \
  "$readiness"

jq -cn \
  --arg image "$image" \
  --arg sourceCommit "$source_commit" \
  --arg proofFile "$proof_file" \
  '{rolledOut: true, image: $image, sourceCommit: $sourceCommit, proofFile: $proofFile}'
