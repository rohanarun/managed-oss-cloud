#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

die() {
  printf 'Existing-instance metadata update refused: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' 'Usage: update-existing-startup-metadata.sh --dry-run|--apply --project PROJECT --zone ZONE --control-instance NAME --control-machine-type TYPE --control-service-account EMAIL --worker-instance NAME --worker-machine-type TYPE --worker-service-account EMAIL --hmac-secret-name NAME --snapshot-dir NEW_DIRECTORY [--manifest PATH]'
}

mode=""
project=""
zone=""
control_instance=""
control_machine_type=""
control_service_account=""
worker_instance=""
worker_machine_type=""
worker_service_account=""
hmac_secret_name=""
snapshot_dir=""
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
manifest="$script_dir/release-v0.4.0.json"
while (( $# > 0 )); do
  case "$1" in
    --dry-run|--apply)
      [[ -z "$mode" ]] || die "choose exactly one of --dry-run or --apply"
      mode="${1#--}"
      shift
      ;;
    --project) project="${2:-}"; shift 2 ;;
    --zone) zone="${2:-}"; shift 2 ;;
    --control-instance) control_instance="${2:-}"; shift 2 ;;
    --control-machine-type) control_machine_type="${2:-}"; shift 2 ;;
    --control-service-account) control_service_account="${2:-}"; shift 2 ;;
    --worker-instance) worker_instance="${2:-}"; shift 2 ;;
    --worker-machine-type) worker_machine_type="${2:-}"; shift 2 ;;
    --worker-service-account) worker_service_account="${2:-}"; shift 2 ;;
    --hmac-secret-name) hmac_secret_name="${2:-}"; shift 2 ;;
    --snapshot-dir) snapshot_dir="${2:-}"; shift 2 ;;
    --manifest) manifest="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$mode" == "dry-run" || "$mode" == "apply" ]] || die "choose exactly one of --dry-run or --apply"
[[ "$project" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]] || die "project is invalid"
[[ "$zone" =~ ^[a-z]+-[a-z0-9]+[0-9]-[a-z]$ ]] || die "zone is invalid"
for value in "$control_instance" "$worker_instance"; do
  [[ "$value" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "instance name is invalid"
done
[[ "$control_instance" != "$worker_instance" ]] || die "control and worker instance names must differ"
for value in "$control_machine_type" "$worker_machine_type"; do
  [[ "$value" =~ ^[a-z][a-z0-9-]{1,62}$ ]] || die "machine type is invalid"
done
for value in "$control_service_account" "$worker_service_account"; do
  [[ "$value" =~ ^[a-z0-9][-a-z0-9.]{0,61}[a-z0-9]@[a-z0-9][-a-z0-9.]+\.iam\.gserviceaccount\.com$ ]] || die "service account is invalid"
done
[[ "$hmac_secret_name" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || die "HMAC Secret Manager name is invalid"
[[ "$snapshot_dir" == /* && ! -e "$snapshot_dir" ]] || die "snapshot directory must be a new absolute path"
[[ -f "$manifest" && ! -L "$manifest" ]] || die "release manifest is unavailable"

for command_name in jq awk sed mktemp chmod mkdir shasum; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is unavailable: $command_name"
done
gcloud_bin="${GCLOUD_BIN:-gcloud}"
command -v "$gcloud_bin" >/dev/null 2>&1 || die "gcloud is unavailable"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

readonly expected_manifest_sha256="a63a2d9238bea56c5a51f761fc81d913e30f41c19a379c70e4442558e95b2931"
[[ "$(sha256_file "$manifest")" == "$expected_manifest_sha256" ]] || die "manifest SHA-256 is not the exact reviewed v0.4.0 reboot configuration"

jq -e '
  .schemaVersion == 1 and
  .releaseVersion == "v0.4.0" and
  .sourceCommit == "4ff94afc860109e683c56c3acffedb8a6c233e03" and
  .controlPlaneImage == "ghcr.io/rohanarun/managed-oss-cloud@sha256:865785081730ce0f459ae925d086b45523e9cd6bda94991a4f7f8aa81cbdb243" and
  .controlRuntime.PROVISIONING_MODE == "dry-run" and
  .controlRuntime.PROVISIONING_WORKER == "disabled" and
  .controlRuntime.SUITE_ENTITLEMENT_MODE == "hosted" and
  .controlRuntime.HOSTING_ENTITLEMENT_MODE == "hosted" and
  .controlRuntime.SUBSCRIPTION_RECONCILIATION_MODE == "disabled" and
  .controlSecretVersions.extendedExternalEvidenceHmac == "1"
' "$manifest" >/dev/null || die "manifest is not the exact safe v0.4.0 release"

repo_root="$(cd -- "$script_dir/../../.." && pwd -P)"
while IFS=$'\t' read -r relative_path expected_sha; do
  [[ "$relative_path" == deploy/google-cloud/* && "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || die "manifest asset entry is invalid"
  asset="$repo_root/$relative_path"
  [[ -f "$asset" && ! -L "$asset" ]] || die "manifest asset is unavailable: $relative_path"
  [[ "$(sha256_file "$asset")" == "$expected_sha" ]] || die "manifest asset digest mismatch: $relative_path"
done < <(jq -r '.assetSha256 | to_entries[] | [.key, .value] | @tsv' "$manifest")

release="$(jq -r '.releaseVersion' "$manifest")"
release_dir="/opt/managed-oss/releases/$release"
manifest_sha="$(sha256_file "$manifest")"
control_reapply="$script_dir/reapply-control-plane.sh"
worker_reapply="$script_dir/reapply-worker.sh"
control_reapply_sha="$(sha256_file "$control_reapply")"
worker_reapply_sha="$(sha256_file "$worker_reapply")"

mkdir -m 0700 "$snapshot_dir"
work_dir="$(mktemp -d "$snapshot_dir/.render.XXXXXXXX")"
chmod 0700 "$work_dir"

render_template() {
  local template="$1"
  local output="$2"
  local instance="$3"
  local machine="$4"
  local reapply_sha="$5"
  local content
  content="$(<"$template")"
  content="${content//@@PROJECT@@/$project}"
  content="${content//@@INSTANCE@@/$instance}"
  content="${content//@@MACHINE_TYPE@@/$machine}"
  content="${content//@@RELEASE@@/$release}"
  content="${content//@@RELEASE_MANIFEST_SHA256@@/$manifest_sha}"
  content="${content//@@REAPPLY_SHA256@@/$reapply_sha}"
  content="${content//@@HMAC_SECRET_NAME@@/$hmac_secret_name}"
  [[ "$content" != *'@@'* ]] || die "startup template contains an unresolved token"
  printf '%s\n' "$content" >"$output"
  chmod 0600 "$output"
}

control_startup="$work_dir/control-startup.sh"
worker_startup="$work_dir/worker-startup.sh"
render_template "$script_dir/startup-control-plane.sh.in" "$control_startup" "$control_instance" "$control_machine_type" "$control_reapply_sha"
render_template "$script_dir/startup-worker.sh.in" "$worker_startup" "$worker_instance" "$worker_machine_type" "$worker_reapply_sha"
grep -F "$hmac_secret_name" "$control_startup" >/dev/null || die "control startup metadata omitted the HMAC Secret Manager name"
if grep -F "$hmac_secret_name" "$worker_startup" >/dev/null || grep -F 'EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET' "$worker_startup" >/dev/null; then
  die "worker startup metadata contains control-plane HMAC configuration"
fi

active_project="$("$gcloud_bin" config get-value project 2>/dev/null)"
[[ "$active_project" == "$project" ]] || die "active gcloud project does not match --project"
project_json="$("$gcloud_bin" projects describe "$project" --format=json)"
jq -e --arg project "$project" '.projectId == $project and .lifecycleState == "ACTIVE"' <<<"$project_json" >/dev/null || die "project lookup mismatched or project is inactive"

describe_instance() {
  "$gcloud_bin" compute instances describe "$1" --project "$project" --zone "$zone" --format=json
}

verify_instance() {
  local json_file="$1"
  local expected_name="$2"
  local expected_machine="$3"
  local expected_service_account="$4"
  jq -e \
    --arg name "$expected_name" \
    --arg zone "$zone" \
    --arg machine "$expected_machine" \
    --arg serviceAccount "$expected_service_account" '
      .name == $name and
      (.zone | endswith("/" + $zone)) and
      (.machineType | endswith("/machineTypes/" + $machine)) and
      .status == "RUNNING" and
      .deletionProtection == true and
      ([.disks[] | select(.boot == true and .autoDelete == false)] | length) == 1 and
      (.serviceAccounts | length) == 1 and
      .serviceAccounts[0].email == $serviceAccount
    ' "$json_file" >/dev/null || die "existing instance identity, machine, service account, running state, or persistent boot disk mismatched: $expected_name"
}

snapshot_instance() {
  local name="$1"
  local machine="$2"
  local service_account="$3"
  local prefix="$4"
  describe_instance "$name" >"$snapshot_dir/before-$prefix.json"
  chmod 0600 "$snapshot_dir/before-$prefix.json"
  verify_instance "$snapshot_dir/before-$prefix.json" "$name" "$machine" "$service_account"
  jq -S '(.metadata.items // []) | map(select(.key != "startup-script")) | sort_by(.key)' "$snapshot_dir/before-$prefix.json" >"$snapshot_dir/before-$prefix-non-startup-metadata.json"
  chmod 0600 "$snapshot_dir/before-$prefix-non-startup-metadata.json"
  jq -j 'first((.metadata.items // [])[]? | select(.key == "startup-script") | .value) // ""' "$snapshot_dir/before-$prefix.json" >"$snapshot_dir/before-$prefix-startup.sh"
  chmod 0600 "$snapshot_dir/before-$prefix-startup.sh"
}

snapshot_instance "$control_instance" "$control_machine_type" "$control_service_account" control
snapshot_instance "$worker_instance" "$worker_machine_type" "$worker_service_account" worker
control_startup_count="$(jq '[.metadata.items[]? | select(.key == "startup-script")] | length' "$snapshot_dir/before-control.json")"
worker_startup_count="$(jq '[.metadata.items[]? | select(.key == "startup-script")] | length' "$snapshot_dir/before-worker.json")"
[[ "$control_startup_count" == "0" ]] || die "control startup-script metadata is no longer absent; review the new state before proceeding"
[[ "$worker_startup_count" == "1" ]] || die "worker must have exactly one existing startup-script metadata value before replacement"

runtime_preflight() {
  local role="$1"
  local name="$2"
  local machine="$3"
  local helper="$4"
  local output
  local helper_sha
  local hmac_argument=""
  if [[ "$role" == "control" ]]; then helper_sha="$control_reapply_sha"; else helper_sha="$worker_reapply_sha"; fi
  [[ "$role" != "control" ]] || hmac_argument=" --hmac-secret-name $hmac_secret_name"
  output="$("$gcloud_bin" compute ssh "$name" --project "$project" --zone "$zone" --tunnel-through-iap --quiet --command "sudo bash -ceu '[[ \"\$(sha256sum \"$release_dir/deploy/google-cloud/reboot/release-v0.4.0.json\" | awk \"{print \\\$1}\")\" == \"$manifest_sha\" ]]; [[ \"\$(sha256sum \"$release_dir/deploy/google-cloud/reboot/$helper\" | awk \"{print \\\$1}\")\" == \"$helper_sha\" ]]; exec $release_dir/deploy/google-cloud/reboot/$helper --project $project --instance $name --machine-type $machine --release-dir $release_dir$hmac_argument --preflight-only'")"
  jq -e --arg role "$role" --arg manifestSha256 "$manifest_sha" '.ok == true and .role == $role and .runtimeReady == true and .releaseManifestSha256 == $manifestSha256' <<<"$output" >/dev/null || die "current $role boot/runtime state did not pass the exact release preflight"
  if [[ "$role" == "control" ]]; then
    jq -e '.billingDisabled == true and .provisioningDryRun == true and .hmacConfigured == true' <<<"$output" >/dev/null || die "control safe-mode or HMAC preflight failed"
  else
    jq -e '.hmacAbsent == true' <<<"$output" >/dev/null || die "worker HMAC isolation preflight failed"
  fi
}

runtime_preflight control "$control_instance" "$control_machine_type" reapply-control-plane.sh
runtime_preflight worker "$worker_instance" "$worker_machine_type" reapply-worker.sh

write_facts() {
  local status="$1"
  local image
  image="$(jq -r '.controlPlaneImage' "$manifest")"
  jq -cn \
    --arg mode "$mode" \
    --arg status "$status" \
    --arg release "$release" \
    --arg sourceCommit "$(jq -r '.sourceCommit' "$manifest")" \
    --arg imageDigest "${image##*@}" \
    --arg project "$project" \
    --arg zone "$zone" \
    --arg controlInstance "$control_instance" \
    --arg workerInstance "$worker_instance" \
    --arg controlBeforeFingerprintHash "$(printf '%s' "$(jq -r '.metadata.fingerprint // ""' "$snapshot_dir/before-control.json")" | shasum -a 256 | awk '{print $1}')" \
    --arg workerBeforeFingerprintHash "$(printf '%s' "$(jq -r '.metadata.fingerprint // ""' "$snapshot_dir/before-worker.json")" | shasum -a 256 | awk '{print $1}')" \
    --arg controlBeforeStartupSha256 "$(sha256_file "$snapshot_dir/before-control-startup.sh")" \
    --arg workerBeforeStartupSha256 "$(sha256_file "$snapshot_dir/before-worker-startup.sh")" \
    --arg controlPlannedStartupSha256 "$(sha256_file "$control_startup")" \
    --arg workerPlannedStartupSha256 "$(sha256_file "$worker_startup")" \
    --arg controlNonStartupMetadataSha256 "$(sha256_file "$snapshot_dir/before-control-non-startup-metadata.json")" \
    --arg workerNonStartupMetadataSha256 "$(sha256_file "$snapshot_dir/before-worker-non-startup-metadata.json")" '
      {
        mode: $mode,
        status: $status,
        release: $release,
        sourceCommit: $sourceCommit,
        imageDigest: $imageDigest,
        project: $project,
        zone: $zone,
        instances: [
          {role: "control", name: $controlInstance, startupTransition: "create-when-absent", beforeStartupPresent: false, beforeMetadataFingerprintSha256: $controlBeforeFingerprintHash, beforeStartupSha256: $controlBeforeStartupSha256, plannedStartupSha256: $controlPlannedStartupSha256, nonStartupMetadataSha256: $controlNonStartupMetadataSha256},
          {role: "worker", name: $workerInstance, startupTransition: "replace-existing", beforeStartupPresent: true, beforeMetadataFingerprintSha256: $workerBeforeFingerprintHash, beforeStartupSha256: $workerBeforeStartupSha256, plannedStartupSha256: $workerPlannedStartupSha256, nonStartupMetadataSha256: $workerNonStartupMetadataSha256}
        ],
        runtimePreflightPassed: true,
        preservesBillingDisabled: true,
        preservesProvisioningDryRun: true,
        controlHmacReferenceOnly: true,
        workerHmacReferenceAbsent: true
      }
    '
}

if [[ "$mode" == "dry-run" ]]; then
  write_facts planned | tee "$snapshot_dir/dry-run-facts.json"
  chmod 0600 "$snapshot_dir/dry-run-facts.json"
  exit 0
fi

apply_one() {
  local name="$1"
  local machine="$2"
  local service_account="$3"
  local prefix="$4"
  local startup="$5"
  local current="$snapshot_dir/current-$prefix.json"
  describe_instance "$name" >"$current"
  chmod 0600 "$current"
  verify_instance "$current" "$name" "$machine" "$service_account"
  [[ "$(jq -r '.metadata.fingerprint // ""' "$current")" == "$(jq -r '.metadata.fingerprint // ""' "$snapshot_dir/before-$prefix.json")" ]] || die "metadata changed after the before snapshot: $name"
  "$gcloud_bin" compute instances add-metadata "$name" --project "$project" --zone "$zone" --metadata-from-file="startup-script=$startup" --quiet
  describe_instance "$name" >"$snapshot_dir/after-$prefix.json"
  chmod 0600 "$snapshot_dir/after-$prefix.json"
  verify_instance "$snapshot_dir/after-$prefix.json" "$name" "$machine" "$service_account"
  jq -S '(.metadata.items // []) | map(select(.key != "startup-script")) | sort_by(.key)' "$snapshot_dir/after-$prefix.json" >"$snapshot_dir/after-$prefix-non-startup-metadata.json"
  chmod 0600 "$snapshot_dir/after-$prefix-non-startup-metadata.json"
  [[ "$(sha256_file "$snapshot_dir/after-$prefix-non-startup-metadata.json")" == "$(sha256_file "$snapshot_dir/before-$prefix-non-startup-metadata.json")" ]] || die "non-startup metadata changed unexpectedly: $name"
  jq -j 'first((.metadata.items // [])[]? | select(.key == "startup-script") | .value) // ""' "$snapshot_dir/after-$prefix.json" >"$snapshot_dir/after-$prefix-startup.sh"
  chmod 0600 "$snapshot_dir/after-$prefix-startup.sh"
  [[ "$(sha256_file "$snapshot_dir/after-$prefix-startup.sh")" == "$(sha256_file "$startup")" ]] || die "startup metadata verification failed: $name"
}

apply_one "$control_instance" "$control_machine_type" "$control_service_account" control "$control_startup"
apply_one "$worker_instance" "$worker_machine_type" "$worker_service_account" worker "$worker_startup"
write_facts applied | tee "$snapshot_dir/apply-facts.json"
chmod 0600 "$snapshot_dir/apply-facts.json"
