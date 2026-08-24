#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly expected_repository="rohanarun/managed-oss-cloud"
readonly expected_image_repository="ghcr.io/rohanarun/managed-oss-cloud"
readonly expected_signer_workflow="rohanarun/managed-oss-cloud/.github/workflows/container.yml"
readonly expected_predicate_type="https://slsa.dev/provenance/v1"
readonly minimum_gh_version="2.97.0"
readonly local_auth_sentinel="unused-public-oci-verification"
readonly manifest_accept="application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"

die() {
  printf 'Image provenance verification failed: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Verify one published Managed OSS control-plane image before deployment.

Usage:
  verify-control-plane-image.sh \
    --image ghcr.io/rohanarun/managed-oss-cloud@sha256:DIGEST \
    --source-commit 40_HEX_COMMIT \
    [--proof-file /absolute/path/proof.json]

The command fails closed unless the remote manifest bytes and digest header
match the pinned digest and GitHub verifies SLSA provenance from the exact
repository, publishing workflow, and source commit. The proof record contains
no registry or GitHub credentials.
EOF
}

image=""
source_commit=""
proof_file=""
while (( $# > 0 )); do
  case "$1" in
    --image)
      [[ $# -ge 2 ]] || die "--image requires a value"
      image="$2"
      shift 2
      ;;
    --source-commit)
      [[ $# -ge 2 ]] || die "--source-commit requires a value"
      source_commit="$2"
      shift 2
      ;;
    --proof-file)
      [[ $# -ge 2 ]] || die "--proof-file requires a value"
      proof_file="$2"
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

[[ "$image" =~ ^ghcr\.io/rohanarun/managed-oss-cloud@sha256:([a-f0-9]{64})$ ]] \
  || die "--image must be the exact allowed GHCR repository pinned by a lowercase sha256 digest"
expected_digest="sha256:${BASH_REMATCH[1]}"
expected_hex="${BASH_REMATCH[1]}"
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]] || die "--source-commit must be an exact lowercase 40-character Git commit"
[[ -z "$proof_file" || "$proof_file" == /* ]] || die "--proof-file must be an absolute path"

curl_bin="${CURL_BIN:-curl}"
gh_bin="${GH_BIN:-gh}"
jq_bin="${JQ_BIN:-jq}"
sha256_bin="${SHA256_BIN:-sha256sum}"
date_bin="${DATE_BIN:-date}"
for command_path in "$curl_bin" "$gh_bin" "$jq_bin" "$sha256_bin" "$date_bin"; do
  command -v "$command_path" >/dev/null 2>&1 || die "required command is unavailable: $command_path"
done

gh_version="$($gh_bin version | head -n 1)" || die "GitHub CLI version could not be determined"
[[ "$gh_version" =~ ^gh[[:space:]]version[[:space:]]([0-9]+)\.([0-9]+)\.([0-9]+)([^0-9.]|$) ]] \
  || die "GitHub CLI returned an unrecognized version string"
gh_major="${BASH_REMATCH[1]}"
gh_minor="${BASH_REMATCH[2]}"
if (( gh_major < 2 || (gh_major == 2 && gh_minor < 97) )); then
  die "GitHub CLI $minimum_gh_version or newer is required for hardened attestation verification"
fi

gh_help="$($gh_bin attestation verify --help 2>&1)" || die "GitHub CLI does not provide attestation verification"
for required_flag in --bundle-from-oci --repo --signer-workflow --signer-digest --source-digest --deny-self-hosted-runners --predicate-type --format; do
  grep -F -- "$required_flag" <<<"$gh_help" >/dev/null \
    || die "GitHub CLI attestation verification does not support required policy flag $required_flag"
done

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/managed-oss-provenance.XXXXXXXX")"
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT
headers_file="$temp_dir/manifest.headers"
manifest_file="$temp_dir/manifest.json"
attestation_file="$temp_dir/attestation.json"

fetch_manifest() {
  local bearer_token="${1:-}"
  local -a curl_args
  curl_args=(
    -sS
    --connect-timeout 10
    --max-time 60
    -H "Accept: $manifest_accept"
  )
  if [[ -n "$bearer_token" ]]; then
    curl_args+=(-H "Authorization: Bearer $bearer_token")
  fi
  "$curl_bin" "${curl_args[@]}" \
    -D "$headers_file" \
    -o "$manifest_file" \
    -w '%{http_code}' \
    "https://ghcr.io/v2/$expected_repository/manifests/$expected_digest"
}

http_status="$(fetch_manifest)" || die "the GHCR manifest request failed"
if [[ "$http_status" == "401" ]]; then
  token_response="$($curl_bin -fsS \
    --connect-timeout 10 \
    --max-time 30 \
    --get \
    --data-urlencode 'service=ghcr.io' \
    --data-urlencode "scope=repository:$expected_repository:pull" \
    'https://ghcr.io/token')" || die "GHCR did not issue an anonymous read token"
  registry_token="$("$jq_bin" -er '.token // .access_token' <<<"$token_response")" \
    || die "GHCR token response did not contain a read token"
  http_status="$(fetch_manifest "$registry_token")" || die "the authenticated GHCR manifest request failed"
fi
[[ "$http_status" == "200" ]] || die "GHCR returned HTTP $http_status for the pinned manifest"
[[ -s "$manifest_file" ]] || die "GHCR returned an empty manifest"

remote_digest="$(awk 'tolower($1) == "docker-content-digest:" { gsub(/\r/, "", $2); value=tolower($2) } END { print value }' "$headers_file")"
[[ "$remote_digest" == "$expected_digest" ]] \
  || die "GHCR Docker-Content-Digest did not match the requested digest"
manifest_hex="$($sha256_bin "$manifest_file" | awk '{ print tolower($1) }')"
[[ "$manifest_hex" == "$expected_hex" ]] \
  || die "the downloaded manifest bytes did not match the requested digest"

GH_TOKEN="$local_auth_sentinel" "$gh_bin" attestation verify "oci://$image" \
  --bundle-from-oci \
  --repo "$expected_repository" \
  --signer-workflow "$expected_signer_workflow" \
  --signer-digest "$source_commit" \
  --source-digest "$source_commit" \
  --deny-self-hosted-runners \
  --predicate-type "$expected_predicate_type" \
  --format json >"$attestation_file" \
  || die "GitHub rejected the image attestation policy"

"$jq_bin" -e \
  --arg subject_name "$expected_image_repository" \
  --arg subject_digest "$expected_hex" '
    type == "array" and length > 0 and
    any(.[];
      any(.verificationResult.statement.subject[]?;
        .name == $subject_name and .digest.sha256 == $subject_digest
      )
    )
  ' "$attestation_file" >/dev/null \
  || die "verified attestations did not contain the exact image subject and digest"

attestation_count="$("$jq_bin" -er 'length' "$attestation_file")"
verified_at="$($date_bin -u +%Y-%m-%dT%H:%M:%SZ)"
proof_record="$($jq_bin -cn \
  --arg image "$image" \
  --arg digest "$expected_digest" \
  --arg repository "$expected_repository" \
  --arg signerWorkflow "$expected_signer_workflow" \
  --arg sourceCommit "$source_commit" \
  --arg predicateType "$expected_predicate_type" \
  --arg verifiedAt "$verified_at" \
  --arg ghVersion "$gh_version" \
  --argjson attestationCount "$attestation_count" '
    {
      schemaVersion: 2,
      verified: true,
      image: $image,
      manifestDigest: $digest,
      manifestBodyDigest: $digest,
      repository: $repository,
      signerWorkflow: $signerWorkflow,
      signerDigest: $sourceCommit,
      sourceCommit: $sourceCommit,
      predicateType: $predicateType,
      attestationSource: "oci-registry",
      deniedSelfHostedRunners: true,
      attestationCount: $attestationCount,
      verifier: $ghVersion,
      verifiedAt: $verifiedAt
    }
  ')"

if [[ -n "$proof_file" ]]; then
  proof_dir="$(dirname -- "$proof_file")"
  [[ -d "$proof_dir" && ! -L "$proof_dir" ]] || die "proof directory must be an existing non-symlink directory"
  [[ ! -e "$proof_file" && ! -L "$proof_file" ]] || die "proof file already exists; provenance records are immutable"
  proof_temp="$(mktemp "$proof_dir/.control-plane-proof.XXXXXXXX")"
  printf '%s\n' "$proof_record" >"$proof_temp"
  chmod 0640 "$proof_temp"
  ln "$proof_temp" "$proof_file" || die "could not atomically create the proof record"
  rm -f -- "$proof_temp"
fi

printf '%s\n' "$proof_record"
