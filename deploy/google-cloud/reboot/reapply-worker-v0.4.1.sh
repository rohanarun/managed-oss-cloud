#!/usr/bin/env bash
set -Eeuo pipefail
set +x

die() {
  printf 'Worker v0.4.1 reboot reapply refused: %s\n' "$*" >&2
  exit 1
}

project=""
instance=""
machine_type=""
release_dir=""
preflight_only=false
while (( $# > 0 )); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --instance) instance="${2:-}"; shift 2 ;;
    --machine-type) machine_type="${2:-}"; shift 2 ;;
    --release-dir) release_dir="${2:-}"; shift 2 ;;
    --preflight-only) preflight_only=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$project" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]] || die "project is invalid"
[[ "$instance" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "instance is invalid"
[[ "$machine_type" =~ ^[a-z][a-z0-9-]{1,62}$ ]] || die "machine type is invalid"
[[ "$release_dir" == /opt/managed-oss/releases/v0.4.1 && -d "$release_dir" && ! -L "$release_dir" ]] || die "release directory is invalid"
[[ "$(stat -c '%u' "$release_dir")" == "0" ]] || die "release directory is not root-owned"

manifest="$release_dir/deploy/google-cloud/reboot/release-v0.4.1.json"
[[ -f "$manifest" && ! -L "$manifest" ]] || die "release manifest is unavailable"
[[ "$(stat -c '%u' "$manifest")" == "0" ]] || die "release manifest is not root-owned"
jq -e '
  .schemaVersion == 1 and
  .releaseVersion == "v0.4.1" and
  .releaseRole == "worker-network-reconciliation-hotfix" and
  .sourceCommit == "429ba369226c3193076959cf3ecb3a173e779a80" and
  .controlPlaneImage == "ghcr.io/rohanarun/managed-oss-cloud@sha256:963a1510094e104e6d0e3b557f04e82b606b4faa2018fc8e9487dbe0da4e18a8" and
  .workerRuntime.WORKER_STORAGE_QUOTA_BACKEND == "measurement-only" and
  .workerRuntime.WORKER_STORAGE_QUOTA_PROOF_COMPLETED == "false"
' "$manifest" >/dev/null || die "release manifest does not preserve the reviewed v0.4.1 worker hotfix"

metadata() {
  curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"
}

[[ "$(metadata project/project-id)" == "$project" ]] || die "project identity mismatch"
[[ "$(metadata instance/name)" == "$instance" ]] || die "instance identity mismatch"
actual_machine_type="$(metadata instance/machine-type)"
[[ "${actual_machine_type##*/}" == "$machine_type" ]] || die "machine type mismatch"

while IFS=$'\t' read -r relative_path expected_sha; do
  [[ "$relative_path" == deploy/google-cloud/* && "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || die "invalid release asset entry"
  asset="$release_dir/$relative_path"
  [[ -f "$asset" && ! -L "$asset" ]] || die "release asset is unavailable"
  [[ "$(stat -c '%u' "$asset")" == "0" ]] || die "release asset is not root-owned"
  [[ "$(sha256sum "$asset" | awk '{print $1}')" == "$expected_sha" ]] || die "release asset digest mismatch"
done < <(jq -r '.assetSha256 | to_entries[] | [.key, .value] | @tsv' "$manifest")

worker_env="/opt/managed-oss/config/worker.env"
[[ -f "$worker_env" && ! -L "$worker_env" ]] || die "current worker configuration is unavailable"
env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found += 1 } END { if (found != 1) exit 1 }' "$worker_env"
}

expected_image="$(jq -r '.controlPlaneImage' "$manifest")"
[[ "$(env_value CONTROL_PLANE_IMAGE)" == "$expected_image" ]] || die "current image is not the exact v0.4.1 digest"
[[ "$(env_value WORKER_NODE_ID)" == "$instance" && "$(env_value WORKER_NODE_NAME)" == "$instance" ]] || die "current worker node identity mismatches the instance"
[[ "$(env_value WORKER_MACHINE_TYPE)" == "$machine_type" ]] || die "current worker machine type is not exact"
while IFS=$'\t' read -r key expected; do
  [[ "$(env_value "$key")" == "$expected" ]] || die "current worker runtime differs from the release manifest"
done < <(jq -r '.workerRuntime | to_entries[] | [.key, .value] | @tsv' "$manifest")
if grep -F 'EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET' "$worker_env" >/dev/null; then
  die "control-plane HMAC configuration leaked into the worker"
fi
[[ -f /opt/managed-oss/.worker-ready && -s /opt/managed-oss/agent/token ]] || die "current worker readiness state is unavailable"

if [[ "$preflight_only" == "true" ]]; then
  agent_id="$(cd /opt/managed-oss/config && docker-compose ps -q agent)"
  caddy_id="$(cd /opt/managed-oss/config && docker-compose ps -q caddy)"
  [[ -n "$agent_id" && -n "$caddy_id" ]] || die "current worker containers are unavailable"
  [[ "$(docker inspect --format '{{.State.Status}}' "$agent_id")" == "running" ]] || die "worker agent is not running"
  [[ "$(docker inspect --format '{{.Config.Image}}' "$agent_id")" == "$expected_image" ]] || die "running worker agent is not the exact v0.4.1 image"
  [[ "$(docker inspect --format '{{.State.Status}}' "$caddy_id")" == "running" ]] || die "worker Caddy is not running"
  curl -fsS --max-time 5 "$(env_value CONTROL_PLANE_AGENT_URL)/api/health" | jq -e '.ok == true and .persistence == "postgres" and .mode == "dry-run"' >/dev/null || die "current worker cannot prove the safe control-plane API health"
  jq -cn \
    --arg role worker \
    --arg release v0.4.1 \
    --arg image "$expected_image" \
    --arg runtimeSha256 "$(sha256sum "$worker_env" | awk '{print $1}')" \
    --arg manifestSha256 "$(sha256sum "$manifest" | awk '{print $1}')" \
    '{ok: true, role: $role, release: $release, image: $image, runtimeReady: true, exactImage: true, hmacAbsent: true, runtimeSha256: $runtimeSha256, releaseManifestSha256: $manifestSha256}'
  exit 0
fi

install -d -m 0750 /opt/managed-oss/readiness /opt/managed-oss/provenance /opt/managed-oss/security
install -d -m 0755 /etc/systemd/system/docker.service.d
install -m 0640 "$release_dir/deploy/google-cloud/worker/docker-compose.yml" /opt/managed-oss/config/docker-compose.yml
install -m 0640 "$release_dir/deploy/google-cloud/worker/Caddyfile" /opt/managed-oss/config/worker-Caddyfile
install -m 0750 "$release_dir/deploy/google-cloud/readiness/worker-ready.sh" /opt/managed-oss/readiness/worker-ready.sh
install -m 0750 "$release_dir/deploy/google-cloud/provenance/verify-control-plane-image.sh" /opt/managed-oss/provenance/verify-control-plane-image.sh
install -m 0750 "$release_dir/deploy/google-cloud/worker/metadata-firewall.sh" /opt/managed-oss/security/metadata-firewall.sh
install -m 0750 "$release_dir/deploy/google-cloud/metadata-firewall-proof.sh" /opt/managed-oss/security/metadata-firewall-proof.sh
install -m 0644 "$release_dir/deploy/google-cloud/worker/managed-oss-metadata-firewall.service" /etc/systemd/system/managed-oss-metadata-firewall.service
install -m 0644 "$release_dir/deploy/google-cloud/worker/docker-metadata-firewall.conf" /etc/systemd/system/docker.service.d/managed-oss-metadata-firewall.conf
systemctl daemon-reload
systemctl enable --now managed-oss-metadata-firewall.service
docker network inspect managed-oss-worker-platform >/dev/null 2>&1 || docker network create managed-oss-worker-platform

cd /opt/managed-oss/config
set -a
source worker.env
set +a
source_commit="$(jq -r '.sourceCommit' "$manifest")"
image_hex="${CONTROL_PLANE_IMAGE##*@sha256:}"
proof="/opt/managed-oss/provenance/reboot-v041-${image_hex}-${source_commit}-$(date -u +%Y%m%dT%H%M%SZ).json"
/opt/managed-oss/provenance/verify-control-plane-image.sh --image "$CONTROL_PLANE_IMAGE" --source-commit "$source_commit" --proof-file "$proof" >/dev/null
docker pull "$CONTROL_PLANE_IMAGE" >/dev/null
metadata_proof="/opt/managed-oss/security/worker-metadata-v041-${image_hex}-$(date -u +%Y%m%dT%H%M%SZ).json"
METADATA_FIREWALL_SCRIPT=/opt/managed-oss/security/metadata-firewall.sh \
  /opt/managed-oss/security/metadata-firewall-proof.sh "$CONTROL_PLANE_IMAGE" >"$metadata_proof"
chmod 0640 "$metadata_proof"
jq -e '.ok == true and .hostMetadata == true and .bridgeIpv4Blocked == true and .bridgeIpv6Blocked == true' "$metadata_proof" >/dev/null || die "metadata firewall proof failed"
docker-compose pull
readiness_epoch="$(date +%s)"
docker-compose up -d
WORKER_READINESS_NOT_BEFORE_EPOCH="$readiness_epoch" \
  MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$metadata_proof" \
  /opt/managed-oss/readiness/worker-ready.sh
