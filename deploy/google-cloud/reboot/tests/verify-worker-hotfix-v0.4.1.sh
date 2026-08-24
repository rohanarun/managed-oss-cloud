#!/usr/bin/env bash
set -Eeuo pipefail

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
reboot_dir="$(cd -- "$test_dir/.." && pwd -P)"
repo_root="$(cd -- "$reboot_dir/../../.." && pwd -P)"
manifest="$reboot_dir/release-v0.4.1.json"
reapply="$reboot_dir/reapply-worker-v0.4.1.sh"
template="$reboot_dir/startup-worker-v0.4.1.sh.in"

bash -n "$reapply"
bash -n "$template"
jq -e '
  .schemaVersion == 1 and
  .releaseVersion == "v0.4.1" and
  .releaseRole == "worker-network-reconciliation-hotfix" and
  .sourceCommit == "429ba369226c3193076959cf3ecb3a173e779a80" and
  .controlPlaneImage == "ghcr.io/rohanarun/managed-oss-cloud@sha256:963a1510094e104e6d0e3b557f04e82b606b4faa2018fc8e9487dbe0da4e18a8" and
  .workerRuntime.WORKER_STORAGE_QUOTA_BACKEND == "measurement-only" and
  .workerRuntime.WORKER_STORAGE_QUOTA_PROOF_COMPLETED == "false"
' "$manifest" >/dev/null

while IFS=$'\t' read -r relative_path expected_sha; do
  [[ "$relative_path" == deploy/google-cloud/* && "$expected_sha" =~ ^[a-f0-9]{64}$ ]]
  [[ "$(shasum -a 256 "$repo_root/$relative_path" | awk '{print $1}')" == "$expected_sha" ]]
done < <(jq -r '.assetSha256 | to_entries[] | [.key, .value] | @tsv' "$manifest")

! grep -F 'EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET' "$manifest" "$reapply" "$template" >/dev/null
grep -F 'running worker agent is not the exact v0.4.1 image' "$reapply" >/dev/null
grep -F 'verify-control-plane-image.sh --image "$CONTROL_PLANE_IMAGE"' "$reapply" >/dev/null
grep -F 'metadata-firewall-proof.sh "$CONTROL_PLANE_IMAGE"' "$reapply" >/dev/null
grep -F 'WORKER_READINESS_NOT_BEFORE_EPOCH' "$reapply" >/dev/null

manifest_sha="$(shasum -a 256 "$manifest" | awk '{print $1}')"
reapply_sha="$(shasum -a 256 "$reapply" | awk '{print $1}')"
rendered="$(sed \
  -e 's/@@PROJECT@@/local-passage-501917-g0/g' \
  -e 's/@@INSTANCE@@/managed-oss-host-worker-0/g' \
  -e 's/@@MACHINE_TYPE@@/e2-standard-2/g' \
  -e "s/@@RELEASE_MANIFEST_SHA256@@/$manifest_sha/g" \
  -e "s/@@REAPPLY_SHA256@@/$reapply_sha/g" \
  "$template")"
[[ "$rendered" != *'@@'* ]]
grep -F "release-v0.4.1.json" <<<"$rendered" >/dev/null
grep -F "$manifest_sha" <<<"$rendered" >/dev/null
grep -F "$reapply_sha" <<<"$rendered" >/dev/null
grep -F 'managed-oss-host-worker-0' <<<"$rendered" >/dev/null
bash -n <(printf '%s\n' "$rendered")

printf 'Worker v0.4.1 reboot hotfix contracts passed.\n'
