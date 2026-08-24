#!/usr/bin/env bash
set -Eeuo pipefail
set +x

die() {
  printf 'Subscription reconciler absence proof failed: %s\n' "$*" >&2
  exit 1
}

docker_bin="${DOCKER_BIN:-docker}"
command -v "$docker_bin" >/dev/null 2>&1 || die "docker is unavailable"

container_ids=""
if ! container_ids="$("$docker_bin" ps -aq --filter label=com.docker.compose.service=subscription-reconciler)"; then
  die "Docker could not enumerate subscription reconciler containers"
fi
[[ -z "$container_ids" ]] || die "a subscription reconciler container exists in any state"

jq -cn '{ok: true, subscriptionReconcilerAbsent: true}'
