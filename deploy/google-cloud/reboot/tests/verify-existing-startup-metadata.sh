#!/usr/bin/env bash
set -Eeuo pipefail
set +x
[[ "${TRACE:-0}" != "1" ]] || set -x

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
reboot_dir="$(cd -- "$test_dir/.." && pwd -P)"
updater="$reboot_dir/update-existing-startup-metadata.sh"
manifest="$reboot_dir/release-v0.4.0.json"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/managed-oss-reboot-test.XXXXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'existing-startup-metadata contract test failed: %s\n' "$*" >&2
  exit 1
}

assert_rejected() {
  local expected="$1"
  shift
  local output
  local status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  (( status != 0 )) || fail "command unexpectedly succeeded: $expected"
  [[ "$output" == *"$expected"* ]] || fail "rejection did not mention $expected"
}

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
  'if [[ "$1 $2 $3" == "compute instances describe" ]]; then cp "$MOCK_STATE_DIR/$4.json" /dev/stdout; exit 0; fi' \
  'if [[ "$1 $2" == "compute ssh" ]]; then' \
  '  remote_command=""; previous=""' \
  '  for argument in "$@"; do [[ "$previous" != "--command" ]] || remote_command="$argument"; previous="$argument"; done' \
  '  [[ -n "$remote_command" ]]; bash -n -c "$remote_command"' \
  '  role=worker; [[ "$3" == "$MOCK_CONTROL_INSTANCE" ]] && role=control' \
  '  if [[ "$role" == control ]]; then jq -cn --arg sha "$MOCK_MANIFEST_SHA" "{ok:true,role:\"control\",runtimeReady:true,billingDisabled:true,provisioningDryRun:true,hmacConfigured:true,runtimeSha256:\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",releaseManifestSha256:\$sha}"; else jq -cn --arg sha "$MOCK_MANIFEST_SHA" "{ok:true,role:\"worker\",runtimeReady:true,hmacAbsent:true,runtimeSha256:\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",releaseManifestSha256:\$sha}"; fi' \
  '  exit 0' \
  'fi' \
  'if [[ "$1 $2 $3" == "compute instances add-metadata" ]]; then' \
  '  instance="$4"; startup_file=""' \
  '  for argument in "$@"; do case "$argument" in --metadata-from-file=startup-script=*) startup_file="${argument#--metadata-from-file=startup-script=}" ;; esac; done' \
  '  [[ -n "$startup_file" && -f "$startup_file" ]]' \
  '  jq --rawfile startup "$startup_file" '\''(.metadata.items //= []) | .metadata.items = ((.metadata.items | map(select(.key != "startup-script"))) + [{key:"startup-script",value:$startup}]) | .metadata.fingerprint = (.metadata.fingerprint + "-updated")'\'' "$MOCK_STATE_DIR/$instance.json" >"$MOCK_STATE_DIR/$instance.next"' \
  '  mv "$MOCK_STATE_DIR/$instance.next" "$MOCK_STATE_DIR/$instance.json"' \
  '  exit 0' \
  'fi' \
  'printf "unexpected fake gcloud invocation\n" >&2; exit 90' >"$mock_gcloud"
chmod 0755 "$mock_gcloud"

project="local-passage-501917-g0"
zone="us-central1-a"
control="managed-oss-host"
worker="managed-oss-host-worker-0"
control_account="managed-oss-host@$project.iam.gserviceaccount.com"
worker_account="managed-oss-worker-0@$project.iam.gserviceaccount.com"
manifest_sha="$(shasum -a 256 "$manifest" | awk '{print $1}')"
log="$test_root/gcloud.log"

write_states() {
  local control_startup="${1:-absent}"
  local worker_startup="${2:-present}"
  jq -cn \
    --arg name "$control" \
    --arg zone "$zone" \
    --arg serviceAccount "$control_account" \
    --arg controlStartup "$control_startup" '
      {
        name:$name,
        zone:("https://www.googleapis.com/compute/v1/projects/example/zones/"+$zone),
        machineType:"https://www.googleapis.com/compute/v1/projects/example/zones/us-central1-a/machineTypes/e2-medium",
        status:"RUNNING",
        deletionProtection:true,
        disks:[{boot:true,autoDelete:false,source:"persistent-control-disk"}],
        serviceAccounts:[{email:$serviceAccount}],
        metadata:{fingerprint:"control-fingerprint",items:([{key:"enable-oslogin",value:"TRUE"}] + (if $controlStartup == "present" then [{key:"startup-script",value:"unexpected-control-script"}] else [] end))}
      }
    ' >"$state_dir/$control.json"
  jq -cn \
    --arg name "$worker" \
    --arg zone "$zone" \
    --arg serviceAccount "$worker_account" \
    --arg workerStartup "$worker_startup" '
      {
        name:$name,
        zone:("https://www.googleapis.com/compute/v1/projects/example/zones/"+$zone),
        machineType:"https://www.googleapis.com/compute/v1/projects/example/zones/us-central1-a/machineTypes/e2-standard-2",
        status:"RUNNING",
        deletionProtection:true,
        disks:[{boot:true,autoDelete:false,source:"persistent-worker-disk"}],
        serviceAccounts:[{email:$serviceAccount}],
        metadata:{fingerprint:"worker-fingerprint",items:([{key:"enable-oslogin",value:"TRUE"}] + (if $workerStartup == "present" then [{key:"startup-script",value:"old-worker-script"}] else [] end))}
      }
    ' >"$state_dir/$worker.json"
}

run_update() {
  local mode="$1"
  local snapshots="$2"
  shift 2
  env \
    GCLOUD_BIN="$mock_gcloud" \
    MOCK_GCLOUD_LOG="$log" \
    MOCK_PROJECT="$project" \
    MOCK_STATE_DIR="$state_dir" \
    MOCK_CONTROL_INSTANCE="$control" \
    MOCK_MANIFEST_SHA="$manifest_sha" \
    "$updater" "--$mode" \
      --project "$project" \
      --zone "$zone" \
      --control-instance "$control" \
      --control-machine-type e2-medium \
      --control-service-account "$control_account" \
      --worker-instance "$worker" \
      --worker-machine-type e2-standard-2 \
      --worker-service-account "$worker_account" \
      --hmac-secret-name managed-oss-extended-external-evidence-hmac \
      --snapshot-dir "$snapshots" \
      "$@"
}

write_states
: >"$log"
dry_snapshots="$test_root/dry-snapshots"
dry_output="$(run_update dry-run "$dry_snapshots")"
jq -e '
  .mode == "dry-run" and
  .status == "planned" and
  .runtimePreflightPassed == true and
  .preservesBillingDisabled == true and
  .preservesProvisioningDryRun == true and
  .instances[0].startupTransition == "create-when-absent" and
  .instances[0].beforeStartupPresent == false and
  .instances[1].startupTransition == "replace-existing" and
  .instances[1].beforeStartupPresent == true
' <<<"$dry_output" >/dev/null || fail "dry-run facts were incomplete"
grep -F 'add-metadata' "$log" >/dev/null && fail "dry run mutated metadata"
[[ -f "$dry_snapshots/before-control.json" && -f "$dry_snapshots/before-worker.json" ]] || fail "dry run omitted before snapshots"
if stat -f '%Lp' "$dry_snapshots/before-control.json" >/dev/null 2>&1; then
  snapshot_mode="$(stat -f '%Lp' "$dry_snapshots/before-control.json")"
else
  snapshot_mode="$(stat -c '%a' "$dry_snapshots/before-control.json")"
fi
[[ "$snapshot_mode" == "600" ]] || fail "raw before snapshot was not private"
grep -F 'managed-oss-extended-external-evidence-hmac' "$dry_snapshots/.render."*/control-startup.sh >/dev/null || fail "control startup omitted the HMAC secret name"
if grep -F 'managed-oss-extended-external-evidence-hmac' "$dry_snapshots/.render."*/worker-startup.sh >/dev/null; then
  fail "worker startup received the HMAC secret name"
fi
if grep -F 'EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET' "$dry_snapshots/.render."*/worker-startup.sh >/dev/null; then
  fail "worker startup received the HMAC environment name"
fi

write_states
: >"$log"
apply_snapshots="$test_root/apply-snapshots"
apply_output="$(run_update apply "$apply_snapshots")"
jq -e '.mode == "apply" and .status == "applied"' <<<"$apply_output" >/dev/null || fail "apply facts were incomplete"
[[ "$(grep -c 'add-metadata' "$log")" == "2" ]] || fail "apply did not perform exactly two metadata-only mutations"
if grep -E 'instances (create|delete|remove-metadata|set-machine-type)|disks (create|delete)|terraform (apply|destroy)' "$log" >/dev/null; then
  fail "apply attempted a destructive or infrastructure mutation"
fi
jq -e '([.metadata.items[] | select(.key == "startup-script")] | length) == 1 and ([.metadata.items[] | select(.key == "enable-oslogin" and .value == "TRUE")] | length) == 1' "$state_dir/$control.json" >/dev/null || fail "control metadata was not merged safely"
jq -e '([.metadata.items[] | select(.key == "startup-script")] | length) == 1 and ([.metadata.items[] | select(.key == "enable-oslogin" and .value == "TRUE")] | length) == 1' "$state_dir/$worker.json" >/dev/null || fail "worker metadata was not merged safely"

write_states present present
: >"$log"
assert_rejected "control startup-script metadata is no longer absent" run_update dry-run "$test_root/refuse-control-replace"
grep -F 'add-metadata' "$log" >/dev/null && fail "control transition refusal mutated metadata"

write_states absent absent
: >"$log"
assert_rejected "worker must have exactly one existing startup-script" run_update dry-run "$test_root/refuse-worker-create"
grep -F 'add-metadata' "$log" >/dev/null && fail "worker transition refusal mutated metadata"

write_states
jq '.machineType = "https://www.googleapis.com/compute/v1/projects/example/zones/us-central1-a/machineTypes/e2-small"' "$state_dir/$control.json" >"$state_dir/control-mismatch.json"
mv "$state_dir/control-mismatch.json" "$state_dir/$control.json"
: >"$log"
assert_rejected "existing instance identity" run_update dry-run "$test_root/refuse-machine-mismatch"
grep -F 'add-metadata' "$log" >/dev/null && fail "machine mismatch mutated metadata"

write_states
altered_manifest="$test_root/altered-release.json"
jq '.controlRuntime.PUBLIC_APP_URL = "https://unexpected.example"' "$manifest" >"$altered_manifest"
: >"$log"
assert_rejected "manifest SHA-256 is not the exact reviewed" run_update dry-run "$test_root/refuse-manifest-drift" --manifest "$altered_manifest"
[[ ! -s "$log" ]] || fail "manifest drift reached gcloud"

if grep -E 'compute instances (create|delete|remove-metadata|set-machine-type)|terraform (apply|destroy)' "$updater" >/dev/null; then
  fail "updater source contains a destructive infrastructure command"
fi

printf 'Existing startup metadata contracts passed.\n'
