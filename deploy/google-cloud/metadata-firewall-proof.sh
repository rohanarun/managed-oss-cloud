#!/usr/bin/env bash
set -Eeuo pipefail
set +x

die() {
  printf 'Docker metadata firewall proof failed: %s\n' "$*" >&2
  exit 1
}

image="${1:-}"
[[ "$image" =~ ^ghcr\.io/rohanarun/managed-oss-cloud@sha256:[a-f0-9]{64}$ ]] \
  || die "an exact digest-pinned managed control-plane image is required"

firewall_script="${METADATA_FIREWALL_SCRIPT:-/opt/managed-oss/security/metadata-firewall.sh}"
docker_bin="${DOCKER_BIN:-docker}"
curl_bin="${CURL_BIN:-curl}"
[[ -x "$firewall_script" ]] || die "the root-owned firewall installer is unavailable"
command -v "$docker_bin" >/dev/null 2>&1 || die "Docker is unavailable"
command -v "$curl_bin" >/dev/null 2>&1 || die "curl is unavailable"

"$firewall_script" verify || die "the IPv4 and IPv6 DOCKER-USER rules are incomplete"
host_instance_id="$($curl_bin -fsS --connect-timeout 2 --max-time 5 \
  -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/id')" \
  || die "trusted-host metadata access failed after bridge isolation"
[[ "$host_instance_id" =~ ^[0-9]+$ ]] || die "trusted-host metadata returned an invalid instance ID"

probe_container_rejection() {
  local address="$1"
  if ! "$docker_bin" run --rm --network bridge --entrypoint node "$image" \
    --input-type=module -e '
      const target = process.argv[1];
      try {
        await fetch(target, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) });
        process.exit(41);
      } catch {
        process.exit(0);
      }
    ' "$address" >/dev/null 2>&1 \
  ; then
    die "a bridge container reached or unexpectedly handled metadata at $address"
  fi
}

probe_container_rejection 'http://169.254.169.254/computeMetadata/v1/instance/id'
probe_container_rejection 'http://[fd20:ce::254]/computeMetadata/v1/instance/id'
printf '{"ok":true,"hostMetadata":true,"bridgeIpv4Blocked":true,"bridgeIpv6Blocked":true}\n'
