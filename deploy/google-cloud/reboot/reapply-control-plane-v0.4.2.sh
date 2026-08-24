#!/usr/bin/env bash
set -Eeuo pipefail
set +x

runtime_temp=""
billing_temp=""
control_temp=""
cleanup() {
  [[ -z "$runtime_temp" ]] || rm -f -- "$runtime_temp"
  [[ -z "$billing_temp" ]] || rm -f -- "$billing_temp"
  [[ -z "$control_temp" ]] || rm -f -- "$control_temp"
}
trap cleanup EXIT

die() {
  printf 'Control-plane v0.4.2 reboot reapply refused: %s\n' "$*" >&2
  exit 1
}

project=""
instance=""
machine_type=""
hmac_secret_name=""
release_dir=""
preflight_only=false
while (( $# > 0 )); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --instance) instance="${2:-}"; shift 2 ;;
    --machine-type) machine_type="${2:-}"; shift 2 ;;
    --hmac-secret-name) hmac_secret_name="${2:-}"; shift 2 ;;
    --release-dir) release_dir="${2:-}"; shift 2 ;;
    --preflight-only) preflight_only=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

readonly expected_release="v0.4.2"
readonly expected_source_commit="20c4a704c77cbbbff1da995e1d91b937625a8aa4"
readonly expected_image="ghcr.io/rohanarun/managed-oss-cloud@sha256:2a32801db1aa72a358527370549d66fb300b57e55e93743917b1b9f0b9ad55d3"
readonly expected_release_dir="/opt/managed-oss/releases/$expected_release"
readonly expected_manifest_sha256="2d34489579f275b15fa86e17ac13eac74ca54a874095e0aa50e479a609403e9b"
readonly expected_project="local-passage-501917-g0"
readonly expected_instance="managed-oss-host"
readonly expected_machine_type="e2-medium"
readonly expected_hmac_secret_name="managed-oss-extended-external-evidence-hmac"

[[ "$project" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]] || die "project is invalid"
[[ "$instance" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "instance is invalid"
[[ "$machine_type" =~ ^[a-z][a-z0-9-]{1,62}$ ]] || die "machine type is invalid"
[[ "$hmac_secret_name" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || die "HMAC Secret Manager name is invalid"
[[ "$project" == "$expected_project" && "$instance" == "$expected_instance" && "$machine_type" == "$expected_machine_type" ]] || die "target is not the exact reviewed v0.4.2 control host"
[[ "$hmac_secret_name" == "$expected_hmac_secret_name" ]] || die "HMAC Secret Manager name is not the reviewed control-only secret"
[[ "$release_dir" == "$expected_release_dir" && -d "$release_dir" && ! -L "$release_dir" ]] || die "release directory is not the exact v0.4.2 path"
[[ "$(stat -c '%u' "$release_dir")" == "0" ]] || die "release directory is not root-owned"

manifest="$release_dir/deploy/google-cloud/reboot/release-v0.4.2.json"
[[ -f "$manifest" && ! -L "$manifest" ]] || die "release manifest is unavailable"
[[ "$(stat -c '%u' "$manifest")" == "0" ]] || die "release manifest is not root-owned"
[[ "$(sha256sum "$manifest" | awk '{print $1}')" == "$expected_manifest_sha256" ]] || die "release manifest is not the exact reviewed v0.4.2 file"
jq -e \
  --arg commit "$expected_source_commit" \
  --arg image "$expected_image" '
    .schemaVersion == 1 and
    .releaseVersion == "v0.4.2" and
    .sourceCommit == $commit and
    .controlPlaneImage == $image and
    .controlRuntime.PROVISIONING_MODE == "dry-run" and
    .controlRuntime.PROVISIONING_WORKER == "disabled" and
    .controlRuntime.DATABASE_MIGRATION_MODE == "manual" and
    .controlRuntime.SUITE_ENTITLEMENT_MODE == "hosted" and
    .controlRuntime.HOSTING_ENTITLEMENT_MODE == "hosted" and
    .controlRuntime.WORKER_STORAGE_QUOTA_BACKEND == "measurement-only" and
    .controlRuntime.WORKER_STORAGE_QUOTA_PROOF_COMPLETED == "false" and
    .controlRuntime.SUBSCRIPTION_RECONCILIATION_MODE == "disabled" and
    .controlRuntime.COMPOSE_PROFILES == "" and
    .billingRuntime.STRIPE_SECRET_KEY == "" and
    .billingRuntime.STRIPE_WEBHOOK_SECRET == "" and
    .billingRuntime.BILLING_MODE == "disabled" and
    .controlSecretVersions.extendedExternalEvidenceHmac == "1" and
    (has("workerRuntime") | not)
  ' "$manifest" >/dev/null || die "release manifest does not preserve the exact safe v0.4.2 control-only contract"

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

runtime_env="/opt/managed-oss/config/runtime.env"
billing_env="/opt/managed-oss/config/billing.env"
control_env="/opt/managed-oss/config/control-plane.env"
[[ -f "$runtime_env" && ! -L "$runtime_env" && -f "$billing_env" && ! -L "$billing_env" && -f "$control_env" && ! -L "$control_env" ]] || die "current control-plane configuration is unavailable"

env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found += 1 } END { if (found != 1) exit 1 }' "$file"
}

[[ "$(env_value "$runtime_env" CONTROL_PLANE_IMAGE)" == "$expected_image" ]] || die "current image is not the exact v0.4.2 digest"
while IFS=$'\t' read -r key expected_value; do
  [[ "$(env_value "$runtime_env" "$key")" == "$expected_value" ]] || die "current runtime value is not the reviewed v0.4.2 value: $key"
done < <(jq -r '.controlRuntime | to_entries[] | [.key, .value] | @tsv' "$manifest")
while IFS=$'\t' read -r key expected_value; do
  [[ "$(env_value "$billing_env" "$key")" == "$expected_value" ]] || die "current billing value is not the reviewed disabled value: $key"
done < <(jq -r '.billingRuntime | to_entries[] | [.key, .value] | @tsv' "$manifest")
publishable_key="$(env_value "$billing_env" STRIPE_PUBLISHABLE_KEY)"
hmac_count="$(awk -F= '$1 == "EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET" && length($0) > length($1) + 1 { found += 1 } END { print found + 0 }' "$control_env")"
[[ "$hmac_count" == "1" ]] || die "current HMAC runtime configuration is missing or duplicated"
[[ -f /opt/managed-oss/.host-ready ]] || die "current host readiness marker is absent"
reconciler_guard="$release_dir/deploy/google-cloud/reboot/assert-subscription-reconciler-absent.sh"
[[ -x "$reconciler_guard" && ! -L "$reconciler_guard" ]] || die "subscription reconciler absence guard is unavailable"
"$reconciler_guard" >/dev/null || die "subscription reconciler absence could not be proved"

if [[ "$preflight_only" == "true" ]]; then
  for service in database control-plane caddy gateway-reconciler; do
    container_id="$(cd /opt/managed-oss/config && docker-compose ps -q "$service")"
    [[ -n "$container_id" && "$(docker inspect --format '{{.State.Status}}' "$container_id")" == "running" ]] || die "current control-plane container state is not running"
    if [[ "$service" == "control-plane" || "$service" == "gateway-reconciler" ]]; then
      [[ "$(docker inspect --format '{{.Config.Image}}' "$container_id")" == "$expected_image" ]] || die "current control-plane service is not using the exact v0.4.2 digest"
    fi
  done
  (cd /opt/managed-oss/config && docker-compose exec -T control-plane node --input-type=module -e '
    const healthResponse = await fetch("http://127.0.0.1:8787/api/health", {signal: AbortSignal.timeout(5000)});
    const health = await healthResponse.json();
    if (!healthResponse.ok || health.ok !== true || health.persistence !== "postgres" || health.mode !== "dry-run") process.exit(1);
    const configResponse = await fetch("http://127.0.0.1:8787/api/config", {signal: AbortSignal.timeout(5000)});
    const config = await configResponse.json();
    if (!configResponse.ok || config.billingReady !== false || config.provisioningMode !== "dry-run") process.exit(1);
  ') >/dev/null || die "current control-plane API health and disabled billing state are not exact"
  jq -cn \
    --arg role control \
    --arg release "$expected_release" \
    --arg sourceCommit "$expected_source_commit" \
    --arg image "$expected_image" \
    --arg runtimeSha256 "$(sha256sum "$runtime_env" | awk '{print $1}')" \
    --arg manifestSha256 "$(sha256sum "$manifest" | awk '{print $1}')" \
    '{ok: true, role: $role, release: $release, sourceCommit: $sourceCommit, image: $image, runtimeReady: true, billingDisabled: true, provisioningDryRun: true, reconciliationDisabled: true, hmacConfigured: true, runtimeSha256: $runtimeSha256, releaseManifestSha256: $manifestSha256}'
  exit 0
fi

umask 077
runtime_temp="$(mktemp /opt/managed-oss/config/.runtime.env.XXXXXXXX)"
{
  printf 'CONTROL_PLANE_IMAGE=%s\n' "$expected_image"
  jq -r '.controlRuntime | to_entries[] | "\(.key)=\(.value)"' "$manifest"
} >"$runtime_temp"
chmod 0600 "$runtime_temp"
mv -f -- "$runtime_temp" "$runtime_env"
runtime_temp=""

billing_temp="$(mktemp /opt/managed-oss/config/.billing.env.XXXXXXXX)"
{
  printf 'STRIPE_SECRET_KEY=\n'
  printf 'STRIPE_PUBLISHABLE_KEY=%s\n' "$publishable_key"
  printf 'STRIPE_WEBHOOK_SECRET=\n'
  printf 'BILLING_MODE=disabled\n'
} >"$billing_temp"
chmod 0600 "$billing_temp"
mv -f -- "$billing_temp" "$billing_env"
billing_temp=""

access_token="$(metadata instance/service-accounts/default/token | jq -er '.access_token')"
hmac_version="$(jq -r '.controlSecretVersions.extendedExternalEvidenceHmac' "$manifest")"
hmac_value="$(curl -fsS -H "Authorization: Bearer $access_token" "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$hmac_secret_name/versions/$hmac_version:access" | jq -er '.payload.data' | base64 -d)"
access_token=""
[[ "$hmac_value" =~ ^[A-Za-z0-9_+=/-]{32,512}$ ]] || die "HMAC secret payload is malformed"
control_temp="$(mktemp /opt/managed-oss/config/.control-plane.env.XXXXXXXX)"
hmac_replaced=false
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET=* ]]; then
    [[ "$hmac_replaced" == "false" ]] || die "duplicate HMAC runtime assignment"
    printf 'EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET=%s\n' "$hmac_value" >>"$control_temp"
    hmac_replaced=true
  else
    printf '%s\n' "$line" >>"$control_temp"
  fi
done <"$control_env"
[[ "$hmac_replaced" == "true" ]] || printf 'EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET=%s\n' "$hmac_value" >>"$control_temp"
hmac_value=""
chmod 0600 "$control_temp"
mv -f -- "$control_temp" "$control_env"
control_temp=""

install -m 0640 "$release_dir/deploy/google-cloud/docker-compose.yml" /opt/managed-oss/config/docker-compose.yml
install -m 0640 "$release_dir/deploy/google-cloud/Caddyfile" /opt/managed-oss/config/Caddyfile

exec "$release_dir/deploy/google-cloud/rollout-control-plane.sh" \
  --source-commit "$expected_source_commit"
