#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
provenance_dir="$(cd -- "$script_dir/.." && pwd -P)"
google_cloud_dir="$(cd -- "$provenance_dir/.." && pwd -P)"
repo_root="$(cd -- "$google_cloud_dir/../.." && pwd -P)"
verifier="$provenance_dir/verify-control-plane-image.sh"
rollout="$google_cloud_dir/rollout-control-plane.sh"
managed_images_workflow="$repo_root/.github/workflows/managed-images.yml"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
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
  (( status != 0 )) || fail "command unexpectedly succeeded: $*"
  [[ "$output" == *"$expected"* ]] || fail "rejection did not contain: $expected"
}

assert_file_contains() {
  local file="$1"
  local expected="$2"
  grep -F -- "$expected" "$file" >/dev/null || fail "$file is missing contract: $expected"
}

bash -n "$verifier"
bash -n "$rollout"

test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mock_dir="$test_root/mock-bin"
proof_dir="$test_root/proofs"
call_log="$test_root/calls.log"
mkdir -p "$mock_dir" "$proof_dir"
: >"$call_log"

manifest_body='manifest-fixture'
manifest_hex='66771e40be6318c007d1d05c54974c6b106870da7c868364042bce455d7576e4'
image="ghcr.io/rohanarun/managed-oss-cloud@sha256:$manifest_hex"
source_commit='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

printf '%s\n' '#!/usr/bin/env bash
printf "curl %s\\n" "$*" >>"$MOCK_CALL_LOG"
headers=""
body=""
while (( $# > 0 )); do
  case "$1" in
    -D) headers="$2"; shift 2 ;;
    -o) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$headers" && -n "$body" ]] || exit 2
remote_digest="${MOCK_REMOTE_DIGEST:-sha256:66771e40be6318c007d1d05c54974c6b106870da7c868364042bce455d7576e4}"
manifest_body="${MOCK_MANIFEST_BODY:-manifest-fixture}"
printf "Docker-Content-Digest: %s\\r\\nContent-Type: application/vnd.oci.image.manifest.v1+json\\r\\n\\r\\n" "$remote_digest" >"$headers"
printf "%s" "$manifest_body" >"$body"
printf "200"' >"$mock_dir/curl"

printf '%s\n' '#!/usr/bin/env bash
printf "gh %s\\n" "$*" >>"$MOCK_CALL_LOG"
if [[ "$1" == "version" ]]; then
  printf "%s\\n" "gh version ${MOCK_GH_VERSION:-2.97.0} (test)"
  exit 0
fi
if [[ "$1 $2 $3" == "attestation verify --help" ]]; then
  if [[ "${MOCK_GH_HELP_INCOMPLETE:-0}" == "1" ]]; then
    printf "%s\\n" "--bundle-from-oci --repo --signer-workflow --signer-digest --source-digest --predicate-type --format"
  else
    printf "%s\\n" "--bundle-from-oci --repo --signer-workflow --signer-digest --source-digest --deny-self-hosted-runners --predicate-type --format"
  fi
  exit 0
fi
[[ "$*" == *"attestation verify oci://ghcr.io/rohanarun/managed-oss-cloud@sha256:66771e40be6318c007d1d05c54974c6b106870da7c868364042bce455d7576e4"* ]] || exit 3
[[ "$*" == *"--bundle-from-oci"* ]] || exit 3
[[ "$*" == *"--repo rohanarun/managed-oss-cloud"* ]] || exit 3
[[ "$*" == *"--signer-workflow rohanarun/managed-oss-cloud/.github/workflows/container.yml"* ]] || exit 3
[[ "$*" == *"--signer-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"* ]] || exit 3
[[ "$*" == *"--source-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"* ]] || exit 3
[[ "$*" == *"--deny-self-hosted-runners"* ]] || exit 3
[[ "$*" == *"--predicate-type https://slsa.dev/provenance/v1"* ]] || exit 3
[[ "${GH_TOKEN:-}" == "unused-public-oci-verification" ]] || exit 3
[[ "${MOCK_GH_FAIL:-0}" == "0" ]] || exit 4
if [[ "${MOCK_GH_WRONG_SUBJECT:-0}" == "1" ]]; then subject_digest="0000000000000000000000000000000000000000000000000000000000000000"; else subject_digest="66771e40be6318c007d1d05c54974c6b106870da7c868364042bce455d7576e4"; fi
printf "[{\"verificationResult\":{\"statement\":{\"subject\":[{\"name\":\"ghcr.io/rohanarun/managed-oss-cloud\",\"digest\":{\"sha256\":\"%s\"}}]}}}]\\n" "$subject_digest"' >"$mock_dir/gh"
chmod 0755 "$mock_dir"/*

proof_file="$proof_dir/success.json"
MOCK_CALL_LOG="$call_log" \
CURL_BIN="$mock_dir/curl" \
GH_BIN="$mock_dir/gh" \
"$verifier" --image "$image" --source-commit "$source_commit" --proof-file "$proof_file" >/dev/null
[[ -f "$proof_file" ]] || fail "successful verification did not emit a proof record"
jq -e \
  --arg image "$image" \
  --arg commit "$source_commit" \
  '.schemaVersion == 2 and .verified == true and .image == $image and .sourceCommit == $commit and .signerDigest == $commit and .attestationSource == "oci-registry" and .attestationCount == 1 and .deniedSelfHostedRunners == true' \
  "$proof_file" >/dev/null || fail "proof record did not preserve the verified policy"

calls_before="$(wc -l <"$call_log")"
assert_rejected "exact allowed GHCR repository" \
  env MOCK_CALL_LOG="$call_log" CURL_BIN="$mock_dir/curl" GH_BIN="$mock_dir/gh" \
  "$verifier" --image "ghcr.io/rohanarun/managed-oss-cloud:latest" --source-commit "$source_commit"
[[ "$(wc -l <"$call_log")" == "$calls_before" ]] || fail "invalid image reached a network verifier"

assert_rejected "Docker-Content-Digest did not match" \
  env MOCK_REMOTE_DIGEST="sha256:$(printf '0%.0s' {1..64})" MOCK_CALL_LOG="$call_log" CURL_BIN="$mock_dir/curl" GH_BIN="$mock_dir/gh" \
  "$verifier" --image "$image" --source-commit "$source_commit" --proof-file "$proof_dir/header-mismatch.json"
[[ ! -e "$proof_dir/header-mismatch.json" ]] || fail "manifest-header mismatch emitted a proof"

assert_rejected "downloaded manifest bytes did not match" \
  env MOCK_MANIFEST_BODY="tampered-manifest" MOCK_CALL_LOG="$call_log" CURL_BIN="$mock_dir/curl" GH_BIN="$mock_dir/gh" \
  "$verifier" --image "$image" --source-commit "$source_commit" --proof-file "$proof_dir/body-mismatch.json"
[[ ! -e "$proof_dir/body-mismatch.json" ]] || fail "manifest-body mismatch emitted a proof"

assert_rejected "GitHub rejected the image attestation policy" \
  env MOCK_GH_FAIL=1 MOCK_CALL_LOG="$call_log" CURL_BIN="$mock_dir/curl" GH_BIN="$mock_dir/gh" \
  "$verifier" --image "$image" --source-commit "$source_commit" --proof-file "$proof_dir/attestation-failure.json"
[[ ! -e "$proof_dir/attestation-failure.json" ]] || fail "failed attestation emitted a proof"

assert_rejected "did not contain the exact image subject" \
  env MOCK_GH_WRONG_SUBJECT=1 MOCK_CALL_LOG="$call_log" CURL_BIN="$mock_dir/curl" GH_BIN="$mock_dir/gh" \
  "$verifier" --image "$image" --source-commit "$source_commit" --proof-file "$proof_dir/wrong-subject.json"
[[ ! -e "$proof_dir/wrong-subject.json" ]] || fail "wrong attestation subject emitted a proof"

assert_rejected "does not support required policy flag --deny-self-hosted-runners" \
  env MOCK_GH_HELP_INCOMPLETE=1 MOCK_CALL_LOG="$call_log" CURL_BIN="$mock_dir/curl" GH_BIN="$mock_dir/gh" \
  "$verifier" --image "$image" --source-commit "$source_commit"

calls_before="$(wc -l <"$call_log")"
assert_rejected "GitHub CLI 2.97.0 or newer is required" \
  env MOCK_GH_VERSION=2.96.0 MOCK_CALL_LOG="$call_log" CURL_BIN="$mock_dir/curl" GH_BIN="$mock_dir/gh" \
  "$verifier" --image "$image" --source-commit "$source_commit"
calls_after="$(wc -l <"$call_log")"
(( calls_after == calls_before + 1 )) || fail "obsolete GitHub CLI reached registry or attestation verification"

rollout_root="$test_root/rollout"
rollout_compose="$rollout_root/config"
rollout_proofs="$rollout_root/proofs"
rollout_security="$rollout_root/installed-security"
rollout_systemd="$rollout_root/systemd"
mkdir -p "$rollout_root/provenance" "$rollout_root/readiness" "$rollout_root/database" "$rollout_root/worker" "$rollout_compose" "$rollout_proofs"
cp "$rollout" "$rollout_root/rollout-control-plane.sh"
printf '%s\n' '#!/usr/bin/env bash
exit 0' >"$rollout_root/worker/metadata-firewall.sh"
printf '%s\n' '[Unit]
[Service]
Type=oneshot' >"$rollout_root/worker/managed-oss-metadata-firewall.service"
printf '%s\n' '[Service]
ExecStartPost=/opt/managed-oss/security/metadata-firewall.sh' >"$rollout_root/worker/docker-metadata-firewall.conf"
printf '%s\n' '#!/usr/bin/env bash
printf "metadata-proof %s\n" "$*" >>"$MOCK_CALL_LOG"
if [[ "${MOCK_METADATA_PROOF_FAIL:-0}" != "0" ]]; then printf "mock metadata-firewall-proof.sh rejected\n" >&2; exit 1; fi
[[ -x "$METADATA_FIREWALL_SCRIPT" && "$1" == ghcr.io/rohanarun/managed-oss-cloud@sha256:* ]] || exit 2
printf "%s\n" "{\"ok\":true,\"hostMetadata\":true,\"bridgeIpv4Blocked\":true,\"bridgeIpv6Blocked\":true}"' >"$rollout_root/metadata-firewall-proof.sh"
printf 'version: "3.9"\n' >"$rollout_compose/docker-compose.yml"
printf 'CONTROL_PLANE_IMAGE=%s\nPROVISIONING_MODE=live\n' "$image" >"$rollout_compose/runtime.env"
printf 'MANAGED_RUNTIME_PASSWORD=fixture\n' >"$rollout_compose/database-role-passwords.env"

printf '%s\n' '#!/usr/bin/env bash
printf "verify %s\\n" "$*" >>"$MOCK_CALL_LOG"
if [[ "${MOCK_VERIFY_FAIL:-0}" != "0" ]]; then
  printf "mock provenance rejected\\n" >&2
  exit 1
fi
image=""
commit=""
proof=""
while (( $# > 0 )); do
  case "$1" in
    --image) image="$2"; shift 2 ;;
    --source-commit) commit="$2"; shift 2 ;;
    --proof-file) proof="$2"; shift 2 ;;
    *) exit 2 ;;
  esac
done
digest="${image##*@}"
jq -cn --arg image "$image" --arg digest "$digest" --arg commit "$commit" "{
  schemaVersion:2,
  verified:true,
  image:\$image,
  manifestDigest:\$digest,
  manifestBodyDigest:\$digest,
  repository:\"rohanarun/managed-oss-cloud\",
  signerWorkflow:\"rohanarun/managed-oss-cloud/.github/workflows/container.yml\",
  signerDigest:\$commit,
  sourceCommit:\$commit,
  predicateType:\"https://slsa.dev/provenance/v1\",
  attestationSource:\"oci-registry\",
  deniedSelfHostedRunners:true,
  attestationCount:1
}" >"$proof"
if [[ "${MOCK_VERIFY_BAD_PROOF:-0}" != "0" ]]; then
  replacement="${proof}.replacement"
  jq ".schemaVersion = 1" "$proof" >"$replacement"
  mv "$replacement" "$proof"
fi' >"$rollout_root/provenance/verify-control-plane-image.sh"

printf '%s\n' '#!/usr/bin/env bash
printf "readiness\\n" >>"$MOCK_CALL_LOG"
jq -e ".ok == true and .hostMetadata == true and .bridgeIpv4Blocked == true and .bridgeIpv6Blocked == true" "$MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE" >/dev/null || exit 2
touch "$MANAGED_OSS_READY_MARKER"' >"$rollout_root/readiness/control-plane-ready.sh"

printf '%s\n' '#!/usr/bin/env bash
printf "database-roles\\n" >>"$MOCK_CALL_LOG"' >"$rollout_root/database/configure-role-logins.sh"

printf '%s\n' '#!/usr/bin/env bash
printf "compose %s\\n" "$*" >>"$MOCK_CALL_LOG"' >"$mock_dir/docker-compose"
printf '%s\n' '#!/usr/bin/env bash
printf "docker %s\\n" "$*" >>"$MOCK_CALL_LOG"' >"$mock_dir/docker"
printf '%s\n' '#!/usr/bin/env bash
printf "systemctl %s\\n" "$*" >>"$MOCK_CALL_LOG"' >"$mock_dir/systemctl"
chmod 0755 "$rollout_root/rollout-control-plane.sh" "$rollout_root/provenance/verify-control-plane-image.sh" "$rollout_root/readiness/control-plane-ready.sh" "$rollout_root/database/configure-role-logins.sh" "$rollout_root/worker/metadata-firewall.sh" "$rollout_root/metadata-firewall-proof.sh" "$mock_dir/docker-compose" "$mock_dir/docker" "$mock_dir/systemctl"

rollout_log="$test_root/rollout.log"
: >"$rollout_log"
MOCK_CALL_LOG="$rollout_log" COMPOSE_BIN="$mock_dir/docker-compose" DOCKER_BIN="$mock_dir/docker" SYSTEMCTL_BIN="$mock_dir/systemctl" \
  "$rollout_root/rollout-control-plane.sh" \
  --source-commit "$source_commit" \
  --compose-dir "$rollout_compose" \
  --proof-dir "$rollout_proofs" \
  --ready-marker "$rollout_root/host-ready" \
  --security-dir "$rollout_security" \
  --systemd-dir "$rollout_systemd" >/dev/null
[[ -f "$rollout_root/host-ready" ]] || fail "successful rollout did not run readiness"
[[ -x "$rollout_security/metadata-firewall.sh" && -x "$rollout_security/metadata-firewall-proof.sh" ]] || fail "rollout did not install the metadata firewall and proof command"
[[ -f "$rollout_systemd/managed-oss-metadata-firewall.service" && -f "$rollout_systemd/docker.service.d/managed-oss-metadata-firewall.conf" ]] || fail "rollout did not install metadata firewall persistence"
verify_line="$(grep -n '^verify ' "$rollout_log" | cut -d: -f1)"
firewall_enable_line="$(grep -n '^systemctl enable --now managed-oss-metadata-firewall.service$' "$rollout_log" | cut -d: -f1)"
docker_pull_line="$(grep -n '^docker pull ' "$rollout_log" | cut -d: -f1)"
metadata_proof_line="$(grep -n '^metadata-proof ' "$rollout_log" | cut -d: -f1)"
pull_line="$(grep -n '^compose --profile operations pull$' "$rollout_log" | cut -d: -f1)"
[[ -n "$firewall_enable_line" && -n "$verify_line" && -n "$docker_pull_line" && -n "$metadata_proof_line" && -n "$pull_line" ]] || fail "rollout omitted a metadata or provenance gate"
(( firewall_enable_line < verify_line && verify_line < docker_pull_line && docker_pull_line < metadata_proof_line && metadata_proof_line < pull_line )) || fail "rollout did not install and prove metadata isolation before Compose"

failed_rollout_log="$test_root/failed-rollout.log"
: >"$failed_rollout_log"
assert_rejected "mock provenance rejected" \
  env MOCK_VERIFY_FAIL=1 MOCK_CALL_LOG="$failed_rollout_log" COMPOSE_BIN="$mock_dir/docker-compose" DOCKER_BIN="$mock_dir/docker" SYSTEMCTL_BIN="$mock_dir/systemctl" \
  "$rollout_root/rollout-control-plane.sh" \
  --source-commit "$source_commit" \
  --compose-dir "$rollout_compose" \
  --proof-dir "$test_root/failed-proofs" \
  --ready-marker "$rollout_root/failed-ready" \
  --security-dir "$rollout_security" \
  --systemd-dir "$rollout_systemd"
grep '^compose ' "$failed_rollout_log" >/dev/null && fail "failed provenance verification reached Compose"

bad_proof_rollout_log="$test_root/bad-proof-rollout.log"
: >"$bad_proof_rollout_log"
assert_rejected "machine-readable provenance proof did not match" \
  env MOCK_VERIFY_BAD_PROOF=1 MOCK_CALL_LOG="$bad_proof_rollout_log" COMPOSE_BIN="$mock_dir/docker-compose" DOCKER_BIN="$mock_dir/docker" SYSTEMCTL_BIN="$mock_dir/systemctl" \
  "$rollout_root/rollout-control-plane.sh" \
  --source-commit "$source_commit" \
  --compose-dir "$rollout_compose" \
  --proof-dir "$test_root/bad-proof-proofs" \
  --ready-marker "$rollout_root/bad-proof-ready" \
  --security-dir "$rollout_security" \
  --systemd-dir "$rollout_systemd"
grep '^compose ' "$bad_proof_rollout_log" >/dev/null && fail "invalid provenance proof reached Compose"

metadata_failure_log="$test_root/metadata-failure-rollout.log"
: >"$metadata_failure_log"
assert_rejected "metadata-firewall-proof.sh" \
  env MOCK_METADATA_PROOF_FAIL=1 MOCK_CALL_LOG="$metadata_failure_log" COMPOSE_BIN="$mock_dir/docker-compose" DOCKER_BIN="$mock_dir/docker" SYSTEMCTL_BIN="$mock_dir/systemctl" \
  "$rollout_root/rollout-control-plane.sh" \
  --source-commit "$source_commit" \
  --compose-dir "$rollout_compose" \
  --proof-dir "$test_root/metadata-failure-proofs" \
  --ready-marker "$rollout_root/metadata-failure-ready" \
  --security-dir "$rollout_security" \
  --systemd-dir "$rollout_systemd"
grep '^compose ' "$metadata_failure_log" >/dev/null && fail "failed metadata isolation proof reached Compose"
[[ ! -e "$rollout_root/metadata-failure-ready" ]] || fail "failed metadata isolation proof reached readiness"

assert_file_contains "$managed_images_workflow" 'needs: validate'
assert_file_contains "$managed_images_workflow" 'npm run typecheck'
assert_file_contains "$managed_images_workflow" 'npm run build'
assert_file_contains "$managed_images_workflow" 'npm run audit:licenses'
assert_file_contains "$managed_images_workflow" 'node deploy/images/heyform/verify-license-metadata.mjs'
assert_file_contains "$managed_images_workflow" 'npm test -- tests/heyform-platform-oauth-patch.test.ts'

printf 'image provenance contract checks passed\n'
