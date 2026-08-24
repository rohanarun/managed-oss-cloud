#!/usr/bin/env bash
set -euo pipefail

ensure_reject_rule() {
  local command_name="$1"
  local destination="$2"
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required metadata firewall command is unavailable: %s\n' "$command_name" >&2
    return 1
  }
  if ! "$command_name" -w 10 -n -L DOCKER-USER >/dev/null 2>&1; then
    "$command_name" -w 10 -N DOCKER-USER
  fi
  if ! "$command_name" -w 10 -C FORWARD -j DOCKER-USER >/dev/null 2>&1; then
    "$command_name" -w 10 -I FORWARD 1 -j DOCKER-USER
  fi
  if ! "$command_name" -w 10 -C DOCKER-USER -d "$destination" -j REJECT >/dev/null 2>&1; then
    "$command_name" -w 10 -I DOCKER-USER 1 -d "$destination" -j REJECT
  fi
}

verify_reject_rule() {
  local command_name="$1"
  local destination="$2"
  command -v "$command_name" >/dev/null 2>&1
  "$command_name" -w 10 -n -L DOCKER-USER >/dev/null
  "$command_name" -w 10 -C FORWARD -j DOCKER-USER >/dev/null
  "$command_name" -w 10 -C DOCKER-USER -d "$destination" -j REJECT >/dev/null
}

case "${1:-apply}" in
  apply)
    ensure_reject_rule iptables 169.254.169.254/32
    ensure_reject_rule ip6tables fd20:ce::254/128
    ;;
  verify)
    verify_reject_rule iptables 169.254.169.254/32
    verify_reject_rule ip6tables fd20:ce::254/128
    ;;
  *)
    printf 'Usage: %s [apply|verify]\n' "$0" >&2
    exit 2
    ;;
esac
