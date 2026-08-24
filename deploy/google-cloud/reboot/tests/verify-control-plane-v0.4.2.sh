#!/usr/bin/env bash
set -Eeuo pipefail
set +x
[[ "${TRACE:-0}" != "1" ]] || set -x

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
reboot_dir="$(cd -- "$test_dir/.." && pwd -P)"
updater="$reboot_dir/update-existing-control-startup-v0.4.2.sh"
manifest="$reboot_dir/release-v0.4.2.json"
reapply="$reboot_dir/reapply-control-plane-v0.4.2.sh"
template="$reboot_dir/startup-control-plane-v0.4.2.sh.in"
reconciler_guard="$reboot_dir/assert-subscription-reconciler-absent.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/managed-oss-control-v042-test.XXXXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'control-plane v0.4.2 reboot contract test failed: %s\n' "$*" >&2
  exit 1
}

assert_rejected() {
  local expected="$1"
  shift
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  (( status != 0 )) || fail "command unexpectedly succeeded: $expected"
  [[ "$output" == *"$expected"* ]] || fail "rejection did not mention $expected"
}

bash -n "$updater" "$reapply" "$template" "$reconciler_guard"
jq -e '
  .schemaVersion == 1 and
  .releaseVersion == "v0.4.2" and
  .sourceCommit == "20c4a704c77cbbbff1da995e1d91b937625a8aa4" and
  .controlPlaneImage == "ghcr.io/rohanarun/managed-oss-cloud@sha256:2a32801db1aa72a358527370549d66fb300b57e55e93743917b1b9f0b9ad55d3" and
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
  (has("workerRuntime") | not) and
  ([.assetSha256 | keys[] | select(test("worker/(docker-compose|Caddyfile)|readiness/worker-ready"))] | length) == 0
' "$manifest" >/dev/null || fail "manifest did not preserve the control-only safe-mode contract"

repo_root="$(cd -- "$reboot_dir/../../.." && pwd -P)"
while IFS=$'\t' read -r relative_path expected_sha; do
  [[ "$(shasum -a 256 "$repo_root/$relative_path" | awk '{print $1}')" == "$expected_sha" ]] || fail "manifest asset digest drifted: $relative_path"
done < <(jq -r '.assetSha256 | to_entries[] | [.key, .value] | @tsv' "$manifest")

grep -F 'readonly expected_release="v0.4.2"' "$reapply" >/dev/null || fail "reapply helper did not pin v0.4.2"
grep -F 'readonly expected_release_dir="/opt/managed-oss/releases/$expected_release"' "$reapply" >/dev/null || fail "reapply helper did not pin the release directory"
grep -F 'readonly expected_instance="managed-oss-host"' "$reapply" >/dev/null || fail "reapply helper did not pin the control host"
grep -F 'BILLING_MODE=disabled' "$reapply" >/dev/null || fail "reapply helper did not rewrite disabled billing"
grep -F 'subscription reconciler absence could not be proved' "$reapply" >/dev/null || fail "reapply helper did not require a reconciler absence proof"
grep -F 'billingReady !== false' "$reapply" >/dev/null || fail "reapply helper did not verify disabled billing through the API"
if grep -E 'gcloud|compute instances|reapply-worker|startup-worker|release-v0\.4\.1' "$reapply" >/dev/null; then
  fail "control reapply helper contains worker or Compute Engine mutation logic"
fi
grep -F "readonly EXPECTED_RELEASE='v0.4.2'" "$template" >/dev/null || fail "startup template did not pin v0.4.2"
grep -F 'reapply-control-plane-v0.4.2.sh' "$template" >/dev/null || fail "startup template omitted the v0.4.2 helper"
if grep -E 'worker|WORKER_NODE|reapply-worker' "$template" >/dev/null; then
  fail "control startup template contains worker runtime logic"
fi

guard_mock="$test_root/docker"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  '[[ "$*" == "ps -aq --filter label=com.docker.compose.service=subscription-reconciler" ]]' \
  'case "${MOCK_RECONCILER_STATE:-absent}" in' \
  '  absent) exit 0 ;;' \
  '  enumeration-failure) exit 17 ;;' \
  '  running|restarting|paused|exited) printf "%s-container-id\n" "$MOCK_RECONCILER_STATE" ;;' \
  '  *) exit 18 ;;' \
  'esac' >"$guard_mock"
chmod 0755 "$guard_mock"
guard_output="$(DOCKER_BIN="$guard_mock" MOCK_RECONCILER_STATE=absent "$reconciler_guard")"
printf '%s\n' "$guard_output" | jq -e '.ok == true and .subscriptionReconcilerAbsent == true' >/dev/null || fail "absence guard omitted its machine-readable proof"
assert_rejected "Docker could not enumerate" env DOCKER_BIN="$guard_mock" MOCK_RECONCILER_STATE=enumeration-failure "$reconciler_guard"
for reconciler_state in running restarting paused exited; do
  assert_rejected "container exists in any state" env DOCKER_BIN="$guard_mock" MOCK_RECONCILER_STATE="$reconciler_state" "$reconciler_guard"
done

mock_dir="$test_root/mock-bin"
state_dir="$test_root/state"
mkdir -p "$mock_dir" "$state_dir"
mock_gcloud="$mock_dir/gcloud"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'printf "%q " "$@" >>"$MOCK_GCLOUD_LOG"; printf "\n" >>"$MOCK_GCLOUD_LOG"' \
  'if [[ "$1 $2 $3" == "config get-value project" ]]; then printf "%s\n" "$MOCK_PROJECT"; exit 0; fi' \
  'if [[ "$1 $2" == "projects describe" ]]; then jq -cn --arg project "$MOCK_PROJECT" "{projectId:\$project,lifecycleState:\"ACTIVE\"}"; exit 0; fi' \
  'if [[ "$1 $2 $3" == "compute instances describe" ]]; then [[ "$4" == "$MOCK_CONTROL_INSTANCE" ]]; cp "$MOCK_STATE_FILE" /dev/stdout; exit 0; fi' \
  'if [[ "$1 $2" == "compute ssh" ]]; then' \
  '  [[ "$3" == "$MOCK_CONTROL_INSTANCE" ]]' \
  '  jq -cn --arg manifestSha "$MOCK_MANIFEST_SHA" --arg commit "$MOCK_SOURCE_COMMIT" --arg image "$MOCK_IMAGE" "{ok:true,role:\"control\",release:\"v0.4.2\",sourceCommit:\$commit,image:\$image,runtimeReady:true,billingDisabled:true,provisioningDryRun:true,reconciliationDisabled:true,hmacConfigured:true,runtimeSha256:\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",releaseManifestSha256:\$manifestSha}"' \
  '  exit 0' \
  'fi' \
  'if [[ "$1 $2 $3" == "compute instances add-metadata" ]]; then' \
  '  [[ "$4" == "$MOCK_CONTROL_INSTANCE" ]]' \
  '  startup_file=""' \
  '  for argument in "$@"; do case "$argument" in --metadata-from-file=startup-script=*) startup_file="${argument#--metadata-from-file=startup-script=}" ;; esac; done' \
  '  [[ -n "$startup_file" && -f "$startup_file" ]]' \
  '  jq --rawfile startup "$startup_file" '\''(.metadata.items //= []) | .metadata.items = ((.metadata.items | map(select(.key != "startup-script"))) + [{key:"startup-script",value:$startup}]) | .metadata.fingerprint = (.metadata.fingerprint + "-updated")'\'' "$MOCK_STATE_FILE" >"$MOCK_STATE_FILE.next"' \
  '  mv "$MOCK_STATE_FILE.next" "$MOCK_STATE_FILE"' \
  '  exit 0' \
  'fi' \
  'printf "unexpected fake gcloud invocation\n" >&2; exit 90' >"$mock_gcloud"
chmod 0755 "$mock_gcloud"

project="local-passage-501917-g0"
zone="us-central1-a"
control="managed-oss-host"
control_account="managed-oss-host@$project.iam.gserviceaccount.com"
source_commit="20c4a704c77cbbbff1da995e1d91b937625a8aa4"
image="ghcr.io/rohanarun/managed-oss-cloud@sha256:2a32801db1aa72a358527370549d66fb300b57e55e93743917b1b9f0b9ad55d3"
manifest_sha="$(shasum -a 256 "$manifest" | awk '{print $1}')"
hmac_secret_name="managed-oss-extended-external-evidence-hmac"
state_file="$state_dir/$control.json"
log="$test_root/gcloud.log"

predecessor_fixture="$test_root/reviewed-v0.4.0-control-startup.sh"
predecessor_content="$(<"$reboot_dir/startup-control-plane.sh.in")"
predecessor_content="${predecessor_content//@@PROJECT@@/$project}"
predecessor_content="${predecessor_content//@@INSTANCE@@/$control}"
predecessor_content="${predecessor_content//@@MACHINE_TYPE@@/e2-medium}"
predecessor_content="${predecessor_content//@@RELEASE@@/v0.4.0}"
predecessor_content="${predecessor_content//@@RELEASE_MANIFEST_SHA256@@/a63a2d9238bea56c5a51f761fc81d913e30f41c19a379c70e4442558e95b2931}"
predecessor_content="${predecessor_content//@@REAPPLY_SHA256@@/6374bc968b523a64ab2126e9838e565d8fc4764bf63d11db8ea8eef7381774e7}"
predecessor_content="${predecessor_content//@@HMAC_SECRET_NAME@@/$hmac_secret_name}"
[[ "$predecessor_content" != *'@@'* ]] || fail "predecessor fixture contains an unresolved token"
printf '%s\n' "$predecessor_content" >"$predecessor_fixture"

write_state() {
  local startup_mode="${1:-v0.4.0}"
  local startup=""
  case "$startup_mode" in
    v0.4.0) startup="$(<"$predecessor_fixture")"$'\n' ;;
    absent) startup="" ;;
    unexpected) startup="#!/usr/bin/env bash
readonly EXPECTED_RELEASE='v0.4.0'
echo unexpected
" ;;
    *) fail "unknown startup fixture" ;;
  esac
  jq -cn \
    --arg name "$control" \
    --arg zone "$zone" \
    --arg serviceAccount "$control_account" \
    --arg startup "$startup" '
      {
        name:$name,
        zone:("https://www.googleapis.com/compute/v1/projects/example/zones/"+$zone),
        machineType:"https://www.googleapis.com/compute/v1/projects/example/zones/us-central1-a/machineTypes/e2-medium",
        status:"RUNNING",
        deletionProtection:true,
        disks:[{boot:true,autoDelete:false,source:"persistent-control-disk"}],
        serviceAccounts:[{email:$serviceAccount}],
        metadata:{fingerprint:"control-fingerprint",items:([{key:"enable-oslogin",value:"TRUE"}] + (if $startup == "" then [] else [{key:"startup-script",value:$startup}] end))}
      }
    ' >"$state_file"
}

run_update() {
  local mode="$1"
  local snapshots="$2"
  shift 2
  env \
    GCLOUD_BIN="$mock_gcloud" \
    MOCK_GCLOUD_LOG="$log" \
    MOCK_PROJECT="$project" \
    MOCK_CONTROL_INSTANCE="$control" \
    MOCK_STATE_FILE="$state_file" \
    MOCK_MANIFEST_SHA="$manifest_sha" \
    MOCK_SOURCE_COMMIT="$source_commit" \
    MOCK_IMAGE="$image" \
    "$updater" "--$mode" \
      --project "$project" \
      --zone "$zone" \
      --control-instance "$control" \
      --control-machine-type e2-medium \
      --control-service-account "$control_account" \
      --hmac-secret-name "$hmac_secret_name" \
      --snapshot-dir "$snapshots" \
      "$@"
}

write_state
: >"$log"
dry_snapshots="$test_root/dry-snapshots"
dry_output="$(run_update dry-run "$dry_snapshots")"
jq -e '
  .mode == "dry-run" and
  .status == "planned" and
  .release == "v0.4.2" and
  .mutationScope == "control-startup-script-only" and
  .control.startupTransition == "replace-existing" and
  .control.currentStartupRelease == "v0.4.0" and
  .runtimePreflightPassed == true and
  .preservesBillingDisabled == true and
  .preservesProvisioningDryRun == true and
  .preservesReconciliationDisabled == true and
  .otherInstancesMutated == false
' < <(printf '%s\n' "$dry_output") >/dev/null || fail "dry-run facts were incomplete"
grep -F 'add-metadata' "$log" >/dev/null && fail "dry run mutated metadata"
[[ -f "$dry_snapshots/before-control.json" && -f "$dry_snapshots/before-control-startup.sh" ]] || fail "dry run omitted before snapshots"
if stat -f '%Lp' "$dry_snapshots/before-control.json" >/dev/null 2>&1; then
  snapshot_mode="$(stat -f '%Lp' "$dry_snapshots/before-control.json")"
else
  snapshot_mode="$(stat -c '%a' "$dry_snapshots/before-control.json")"
fi
[[ "$snapshot_mode" == "600" ]] || fail "raw before snapshot was not private"

write_state
: >"$log"
apply_snapshots="$test_root/apply-snapshots"
apply_output="$(run_update apply "$apply_snapshots")"
printf '%s\n' "$apply_output" | jq -e '.mode == "apply" and .status == "applied" and .otherInstancesMutated == false' >/dev/null || fail "apply facts were incomplete"
[[ "$(grep -c 'compute instances add-metadata' "$log")" == "1" ]] || fail "apply did not perform exactly one metadata mutation"
grep -Fq "instances add-metadata $control " "$log" || fail "metadata mutation did not target only the control host"
if grep -E 'managed-oss-host-worker|instances (create|delete|remove-metadata|set-machine-type)|disks (create|delete)|terraform (apply|destroy)' "$log" >/dev/null; then
  fail "apply attempted a worker, destructive, or infrastructure mutation"
fi
jq -e '([.metadata.items[] | select(.key == "startup-script")] | length) == 1 and ([.metadata.items[] | select(.key == "enable-oslogin" and .value == "TRUE")] | length) == 1' "$state_file" >/dev/null || fail "control metadata was not merged safely"
jq -r '.metadata.items[] | select(.key == "startup-script") | .value' "$state_file" | grep -F "EXPECTED_RELEASE='v0.4.2'" >/dev/null || fail "applied startup metadata did not pin v0.4.2"

write_state absent
: >"$log"
assert_rejected "control must have exactly one existing startup-script" run_update dry-run "$test_root/refuse-absent-startup"
grep -F 'add-metadata' "$log" >/dev/null && fail "absent-startup refusal mutated metadata"

write_state unexpected
: >"$log"
assert_rejected "neither the reviewed v0.4.0 predecessor nor this exact v0.4.2 script" run_update dry-run "$test_root/refuse-unexpected-startup"
grep -F 'add-metadata' "$log" >/dev/null && fail "unexpected-startup refusal mutated metadata"

write_state
: >"$log"
assert_rejected "target is not the exact reviewed v0.4.2 control host" run_update dry-run "$test_root/refuse-worker-target" --control-instance managed-oss-host-worker-0
[[ ! -s "$log" ]] || fail "worker-target refusal reached gcloud"

write_state
altered_manifest="$test_root/altered-release.json"
jq '.controlRuntime.PUBLIC_APP_URL = "https://unexpected.example"' "$manifest" >"$altered_manifest"
: >"$log"
assert_rejected "manifest SHA-256 is not the exact reviewed" run_update dry-run "$test_root/refuse-manifest-drift" --manifest "$altered_manifest"
[[ ! -s "$log" ]] || fail "manifest drift reached gcloud"

if grep -E 'compute instances (create|delete|remove-metadata|set-machine-type)|disks (create|delete)|terraform (apply|destroy)' "$updater" >/dev/null; then
  fail "updater source contains a destructive infrastructure command"
fi
[[ "$(grep -c 'compute instances add-metadata' "$updater")" == "1" ]] || fail "updater source does not contain exactly one bounded metadata mutation"

printf 'Control-plane v0.4.2 reboot contracts passed.\n'
