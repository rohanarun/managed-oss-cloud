#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

die() {
  printf 'Existing control startup v0.4.2 update refused: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' 'Usage: update-existing-control-startup-v0.4.2.sh --dry-run|--apply --project PROJECT --zone ZONE --control-instance NAME --control-machine-type TYPE --control-service-account EMAIL --hmac-secret-name NAME --snapshot-dir NEW_DIRECTORY [--manifest PATH]'
}

mode=""
project=""
zone=""
control_instance=""
control_machine_type=""
control_service_account=""
hmac_secret_name=""
snapshot_dir=""
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
manifest="$script_dir/release-v0.4.2.json"
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
    --hmac-secret-name) hmac_secret_name="${2:-}"; shift 2 ;;
    --snapshot-dir) snapshot_dir="${2:-}"; shift 2 ;;
    --manifest) manifest="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

readonly expected_release="v0.4.2"
readonly expected_source_commit="20c4a704c77cbbbff1da995e1d91b937625a8aa4"
readonly expected_image="ghcr.io/rohanarun/managed-oss-cloud@sha256:2a32801db1aa72a358527370549d66fb300b57e55e93743917b1b9f0b9ad55d3"
readonly expected_manifest_sha256="2d34489579f275b15fa86e17ac13eac74ca54a874095e0aa50e479a609403e9b"
readonly expected_project="local-passage-501917-g0"
readonly expected_zone="us-central1-a"
readonly expected_control_instance="managed-oss-host"
readonly expected_control_machine_type="e2-medium"
readonly expected_control_service_account="managed-oss-host@local-passage-501917-g0.iam.gserviceaccount.com"
readonly expected_hmac_secret_name="managed-oss-extended-external-evidence-hmac"
readonly expected_reapply_sha256="6e83f6a41dc49452e71800601a0e39dfb6f2a8990b47bf7b95c9c9e8be42e101"
readonly expected_startup_template_sha256="02a6bfed1d9d5f0dc730c68b69a797ce8390e248e4a430aeeae4eaa3dde019af"
readonly expected_predecessor_manifest_sha256="a63a2d9238bea56c5a51f761fc81d913e30f41c19a379c70e4442558e95b2931"
readonly expected_predecessor_reapply_sha256="6374bc968b523a64ab2126e9838e565d8fc4764bf63d11db8ea8eef7381774e7"
readonly expected_predecessor_template_sha256="8debcd9b74ea0bab3a1d0edeef6de35d57ebe6ecf0e953b69c847b348c73572b"

[[ "$mode" == "dry-run" || "$mode" == "apply" ]] || die "choose exactly one of --dry-run or --apply"
[[ "$project" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]] || die "project is invalid"
[[ "$zone" =~ ^[a-z]+-[a-z0-9]+[0-9]-[a-z]$ ]] || die "zone is invalid"
[[ "$control_instance" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "control instance name is invalid"
[[ "$control_machine_type" =~ ^[a-z][a-z0-9-]{1,62}$ ]] || die "control machine type is invalid"
[[ "$control_service_account" =~ ^[a-z0-9][-a-z0-9.]{0,61}[a-z0-9]@[a-z0-9][-a-z0-9.]+\.iam\.gserviceaccount\.com$ ]] || die "control service account is invalid"
[[ "$hmac_secret_name" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || die "HMAC Secret Manager name is invalid"
[[ "$project" == "$expected_project" && "$zone" == "$expected_zone" ]] || die "project or zone is not the exact reviewed v0.4.2 control location"
[[ "$control_instance" == "$expected_control_instance" && "$control_machine_type" == "$expected_control_machine_type" && "$control_service_account" == "$expected_control_service_account" ]] || die "target is not the exact reviewed v0.4.2 control host"
[[ "$hmac_secret_name" == "$expected_hmac_secret_name" ]] || die "HMAC Secret Manager name is not the reviewed control-only secret"
[[ "$snapshot_dir" == /* && ! -e "$snapshot_dir" ]] || die "snapshot directory must be a new absolute path"
[[ -f "$manifest" && ! -L "$manifest" ]] || die "release manifest is unavailable"

for command_name in jq awk grep mktemp chmod mkdir shasum; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is unavailable: $command_name"
done
gcloud_bin="${GCLOUD_BIN:-gcloud}"
command -v "$gcloud_bin" >/dev/null 2>&1 || die "gcloud is unavailable"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

[[ "$(sha256_file "$manifest")" == "$expected_manifest_sha256" ]] || die "manifest SHA-256 is not the exact reviewed v0.4.2 control-only configuration"
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
  ' "$manifest" >/dev/null || die "manifest is not the exact safe v0.4.2 control-only release"

repo_root="$(cd -- "$script_dir/../../.." && pwd -P)"
while IFS=$'\t' read -r relative_path expected_sha; do
  [[ "$relative_path" == deploy/google-cloud/* && "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || die "manifest asset entry is invalid"
  asset="$repo_root/$relative_path"
  [[ -f "$asset" && ! -L "$asset" ]] || die "manifest asset is unavailable: $relative_path"
  [[ "$(sha256_file "$asset")" == "$expected_sha" ]] || die "manifest asset digest mismatch: $relative_path"
done < <(jq -r '.assetSha256 | to_entries[] | [.key, .value] | @tsv' "$manifest")

release_dir="/opt/managed-oss/releases/$expected_release"
manifest_sha="$(sha256_file "$manifest")"
reapply="$script_dir/reapply-control-plane-v0.4.2.sh"
startup_template="$script_dir/startup-control-plane-v0.4.2.sh.in"
[[ -f "$reapply" && ! -L "$reapply" && -f "$startup_template" && ! -L "$startup_template" ]] || die "v0.4.2 control startup assets are unavailable"
[[ "$(sha256_file "$reapply")" == "$expected_reapply_sha256" ]] || die "v0.4.2 reapply helper SHA-256 is not the reviewed value"
[[ "$(sha256_file "$startup_template")" == "$expected_startup_template_sha256" ]] || die "v0.4.2 startup template SHA-256 is not the reviewed value"
reapply_sha="$expected_reapply_sha256"

predecessor_manifest="$script_dir/release-v0.4.0.json"
predecessor_reapply="$script_dir/reapply-control-plane.sh"
predecessor_template="$script_dir/startup-control-plane.sh.in"
[[ -f "$predecessor_manifest" && ! -L "$predecessor_manifest" && -f "$predecessor_reapply" && ! -L "$predecessor_reapply" && -f "$predecessor_template" && ! -L "$predecessor_template" ]] || die "reviewed v0.4.0 predecessor assets are unavailable"
[[ "$(sha256_file "$predecessor_manifest")" == "$expected_predecessor_manifest_sha256" ]] || die "v0.4.0 predecessor manifest SHA-256 drifted"
[[ "$(sha256_file "$predecessor_reapply")" == "$expected_predecessor_reapply_sha256" ]] || die "v0.4.0 predecessor reapply SHA-256 drifted"
[[ "$(sha256_file "$predecessor_template")" == "$expected_predecessor_template_sha256" ]] || die "v0.4.0 predecessor template SHA-256 drifted"

mkdir -m 0700 "$snapshot_dir"
work_dir="$(mktemp -d "$snapshot_dir/.render.XXXXXXXX")"
chmod 0700 "$work_dir"
control_startup="$work_dir/control-startup.sh"
template_content="$(<"$startup_template")"
template_content="${template_content//@@PROJECT@@/$project}"
template_content="${template_content//@@INSTANCE@@/$control_instance}"
template_content="${template_content//@@MACHINE_TYPE@@/$control_machine_type}"
template_content="${template_content//@@RELEASE_MANIFEST_SHA256@@/$manifest_sha}"
template_content="${template_content//@@REAPPLY_SHA256@@/$reapply_sha}"
template_content="${template_content//@@HMAC_SECRET_NAME@@/$hmac_secret_name}"
[[ "$template_content" != *'@@'* ]] || die "startup template contains an unresolved token"
printf '%s\n' "$template_content" >"$control_startup"
chmod 0600 "$control_startup"
grep -F "$hmac_secret_name" "$control_startup" >/dev/null || die "control startup metadata omitted the HMAC Secret Manager name"
grep -F "EXPECTED_RELEASE='v0.4.2'" "$control_startup" >/dev/null || die "control startup metadata omitted the exact release"

predecessor_startup="$work_dir/reviewed-v0.4.0-control-startup.sh"
predecessor_content="$(<"$predecessor_template")"
predecessor_content="${predecessor_content//@@PROJECT@@/$project}"
predecessor_content="${predecessor_content//@@INSTANCE@@/$control_instance}"
predecessor_content="${predecessor_content//@@MACHINE_TYPE@@/$control_machine_type}"
predecessor_content="${predecessor_content//@@RELEASE@@/v0.4.0}"
predecessor_content="${predecessor_content//@@RELEASE_MANIFEST_SHA256@@/$expected_predecessor_manifest_sha256}"
predecessor_content="${predecessor_content//@@REAPPLY_SHA256@@/$expected_predecessor_reapply_sha256}"
predecessor_content="${predecessor_content//@@HMAC_SECRET_NAME@@/$hmac_secret_name}"
[[ "$predecessor_content" != *'@@'* ]] || die "v0.4.0 predecessor template contains an unresolved token"
printf '%s\n' "$predecessor_content" >"$predecessor_startup"
chmod 0600 "$predecessor_startup"

active_project="$("$gcloud_bin" config get-value project 2>/dev/null)"
[[ "$active_project" == "$project" ]] || die "active gcloud project does not match --project"
project_json="$("$gcloud_bin" projects describe "$project" --format=json)"
jq -e --arg project "$project" '.projectId == $project and .lifecycleState == "ACTIVE"' <<<"$project_json" >/dev/null || die "project lookup mismatched or project is inactive"

describe_control() {
  "$gcloud_bin" compute instances describe "$control_instance" --project "$project" --zone "$zone" --format=json
}

verify_control() {
  local json_file="$1"
  jq -e \
    --arg name "$control_instance" \
    --arg zone "$zone" \
    --arg machine "$control_machine_type" \
    --arg serviceAccount "$control_service_account" '
      .name == $name and
      (.zone | endswith("/" + $zone)) and
      (.machineType | endswith("/machineTypes/" + $machine)) and
      .status == "RUNNING" and
      .deletionProtection == true and
      ([.disks[] | select(.boot == true and .autoDelete == false)] | length) == 1 and
      (.serviceAccounts | length) == 1 and
      .serviceAccounts[0].email == $serviceAccount
    ' "$json_file" >/dev/null || die "existing control identity, machine, service account, running state, or persistent boot disk mismatched"
}

describe_control >"$snapshot_dir/before-control.json"
chmod 0600 "$snapshot_dir/before-control.json"
verify_control "$snapshot_dir/before-control.json"
jq -S '(.metadata.items // []) | map(select(.key != "startup-script")) | sort_by(.key)' "$snapshot_dir/before-control.json" >"$snapshot_dir/before-control-non-startup-metadata.json"
chmod 0600 "$snapshot_dir/before-control-non-startup-metadata.json"
jq -j 'first((.metadata.items // [])[]? | select(.key == "startup-script") | .value) // ""' "$snapshot_dir/before-control.json" >"$snapshot_dir/before-control-startup.sh"
chmod 0600 "$snapshot_dir/before-control-startup.sh"
control_startup_count="$(jq '[.metadata.items[]? | select(.key == "startup-script")] | length' "$snapshot_dir/before-control.json")"
[[ "$control_startup_count" == "1" ]] || die "control must have exactly one existing startup-script before replacement"
current_startup_release=""
if [[ "$(sha256_file "$snapshot_dir/before-control-startup.sh")" == "$(sha256_file "$predecessor_startup")" ]]; then
  current_startup_release="v0.4.0"
elif [[ "$(sha256_file "$snapshot_dir/before-control-startup.sh")" == "$(sha256_file "$control_startup")" ]]; then
  current_startup_release="v0.4.2"
else
  die "existing control startup script is neither the reviewed v0.4.0 predecessor nor this exact v0.4.2 script"
fi

remote_output="$("$gcloud_bin" compute ssh "$control_instance" --project "$project" --zone "$zone" --tunnel-through-iap --quiet --command "sudo bash -ceu '[[ \"\$(sha256sum \"$release_dir/deploy/google-cloud/reboot/release-v0.4.2.json\" | awk \"{print \\\$1}\")\" == \"$manifest_sha\" ]]; [[ \"\$(sha256sum \"$release_dir/deploy/google-cloud/reboot/reapply-control-plane-v0.4.2.sh\" | awk \"{print \\\$1}\")\" == \"$reapply_sha\" ]]; exec $release_dir/deploy/google-cloud/reboot/reapply-control-plane-v0.4.2.sh --project $project --instance $control_instance --machine-type $control_machine_type --hmac-secret-name $hmac_secret_name --release-dir $release_dir --preflight-only'")"
jq -e \
  --arg manifestSha256 "$manifest_sha" \
  --arg commit "$expected_source_commit" \
  --arg image "$expected_image" '
    .ok == true and
    .role == "control" and
    .release == "v0.4.2" and
    .sourceCommit == $commit and
    .image == $image and
    .runtimeReady == true and
    .billingDisabled == true and
    .provisioningDryRun == true and
    .reconciliationDisabled == true and
    .hmacConfigured == true and
    .releaseManifestSha256 == $manifestSha256
  ' <<<"$remote_output" >/dev/null || die "current control boot/runtime state did not pass the exact safe v0.4.2 preflight"

write_facts() {
  local status="$1"
  jq -cn \
    --arg mode "$mode" \
    --arg status "$status" \
    --arg release "$expected_release" \
    --arg sourceCommit "$expected_source_commit" \
    --arg imageDigest "${expected_image##*@}" \
    --arg project "$project" \
    --arg zone "$zone" \
    --arg controlInstance "$control_instance" \
    --arg currentStartupRelease "$current_startup_release" \
    --arg beforeMetadataFingerprintHash "$(printf '%s' "$(jq -r '.metadata.fingerprint // ""' "$snapshot_dir/before-control.json")" | shasum -a 256 | awk '{print $1}')" \
    --arg beforeStartupSha256 "$(sha256_file "$snapshot_dir/before-control-startup.sh")" \
    --arg plannedStartupSha256 "$(sha256_file "$control_startup")" \
    --arg nonStartupMetadataSha256 "$(sha256_file "$snapshot_dir/before-control-non-startup-metadata.json")" '
      {
        mode: $mode,
        status: $status,
        release: $release,
        sourceCommit: $sourceCommit,
        imageDigest: $imageDigest,
        project: $project,
        zone: $zone,
        mutationScope: "control-startup-script-only",
        control: {
          name: $controlInstance,
          startupTransition: "replace-existing",
          currentStartupRelease: $currentStartupRelease,
          beforeMetadataFingerprintSha256: $beforeMetadataFingerprintHash,
          beforeStartupSha256: $beforeStartupSha256,
          plannedStartupSha256: $plannedStartupSha256,
          nonStartupMetadataSha256: $nonStartupMetadataSha256
        },
        runtimePreflightPassed: true,
        preservesBillingDisabled: true,
        preservesProvisioningDryRun: true,
        preservesReconciliationDisabled: true,
        controlHmacReferenceOnly: true,
        otherInstancesMutated: false
      }
    '
}

if [[ "$mode" == "dry-run" ]]; then
  write_facts planned | tee "$snapshot_dir/dry-run-facts.json"
  chmod 0600 "$snapshot_dir/dry-run-facts.json"
  exit 0
fi

current_control="$snapshot_dir/current-control.json"
describe_control >"$current_control"
chmod 0600 "$current_control"
verify_control "$current_control"
[[ "$(jq -r '.metadata.fingerprint // ""' "$current_control")" == "$(jq -r '.metadata.fingerprint // ""' "$snapshot_dir/before-control.json")" ]] || die "control metadata changed after the before snapshot"
"$gcloud_bin" compute instances add-metadata "$control_instance" --project "$project" --zone "$zone" --metadata-from-file="startup-script=$control_startup" --quiet
describe_control >"$snapshot_dir/after-control.json"
chmod 0600 "$snapshot_dir/after-control.json"
verify_control "$snapshot_dir/after-control.json"
jq -S '(.metadata.items // []) | map(select(.key != "startup-script")) | sort_by(.key)' "$snapshot_dir/after-control.json" >"$snapshot_dir/after-control-non-startup-metadata.json"
chmod 0600 "$snapshot_dir/after-control-non-startup-metadata.json"
[[ "$(sha256_file "$snapshot_dir/after-control-non-startup-metadata.json")" == "$(sha256_file "$snapshot_dir/before-control-non-startup-metadata.json")" ]] || die "non-startup control metadata changed unexpectedly"
jq -j 'first((.metadata.items // [])[]? | select(.key == "startup-script") | .value) // ""' "$snapshot_dir/after-control.json" >"$snapshot_dir/after-control-startup.sh"
chmod 0600 "$snapshot_dir/after-control-startup.sh"
[[ "$(sha256_file "$snapshot_dir/after-control-startup.sh")" == "$(sha256_file "$control_startup")" ]] || die "control startup metadata verification failed"
write_facts applied | tee "$snapshot_dir/apply-facts.json"
chmod 0600 "$snapshot_dir/apply-facts.json"
