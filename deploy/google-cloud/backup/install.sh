#!/usr/bin/env bash
set -Eeuo pipefail
set +x

umask 077

usage() {
  cat <<'EOF'
Install the control-plane backup and restore-verification commands plus their
systemd service and timer.

Usage:
  sudo ./install.sh
  sudo ./install.sh --enable --first-restore-proof-completed

The default install writes an example configuration only when no configuration
exists and disables the timer. Enabling validates that a non-placeholder bucket
is configured and requires the explicit first-restore-proof acknowledgement.
The installer does not run a backup or restore verification automatically.
EOF
}

enable_timer=0
first_restore_proof_completed=0
while (( $# > 0 )); do
  case "$1" in
    --enable) enable_timer=1 ;;
    --first-restore-proof-completed) first_restore_proof_completed=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if (( first_restore_proof_completed == 1 && enable_timer == 0 )); then
  printf '%s\n' '--first-restore-proof-completed is valid only with --enable.' >&2
  exit 2
fi
if (( enable_timer == 1 && first_restore_proof_completed == 0 )); then
  printf 'Refusing to enable backups before --first-restore-proof-completed is supplied after a successful restore-verification drill.\n' >&2
  exit 1
fi
[[ "${EUID:-$(id -u)}" -eq 0 ]] || { printf 'Run this installer as root.\n' >&2; exit 1; }

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
config_dir="/opt/managed-oss/config"
work_dir="/opt/managed-oss/backups/control-plane"
config_file="$config_dir/control-plane-backup.env"

[[ ! -L "$config_dir" && ! -L "$work_dir" ]] || {
  printf 'Refusing to install through a symlinked configuration or work directory.\n' >&2
  exit 1
}

install -d -o root -g root -m 0750 "$config_dir"
install -d -o root -g root -m 0700 "$work_dir"
[[ ! -L "$config_file" ]] || {
  printf 'Refusing to install through a symlinked backup configuration: %s\n' "$config_file" >&2
  exit 1
}
install -o root -g root -m 0750 "$script_dir/control-plane-backup.sh" /usr/local/sbin/managed-oss-control-plane-backup
install -o root -g root -m 0750 "$script_dir/control-plane-restore-verify.sh" /usr/local/sbin/managed-oss-control-plane-restore-verify
install -o root -g root -m 0644 "$script_dir/systemd/managed-oss-control-plane-backup.service" /etc/systemd/system/managed-oss-control-plane-backup.service
install -o root -g root -m 0644 "$script_dir/systemd/managed-oss-control-plane-backup.timer" /etc/systemd/system/managed-oss-control-plane-backup.timer

if [[ ! -e "$config_file" ]]; then
  install -o root -g root -m 0600 "$script_dir/control-plane-backup.env.example" "$config_file"
  printf 'Created %s; set CONTROL_PLANE_BACKUP_BUCKET before enabling the timer.\n' "$config_file"
else
  [[ -f "$config_file" ]] || {
    printf 'Existing backup configuration must be a regular non-symlink file: %s\n' "$config_file" >&2
    exit 1
  }
  chown root:root "$config_file"
  chmod 0600 "$config_file"
  printf 'Preserved existing %s.\n' "$config_file"
fi

systemctl daemon-reload

if (( enable_timer == 1 )); then
  bucket="$(awk -F= '$1 == "CONTROL_PLANE_BACKUP_BUCKET" { sub(/^[^=]*=/, ""); print; exit }' "$config_file")"
  [[ -n "$bucket" && "$bucket" != "replace-with-private-backup-bucket" ]] || {
    printf 'Configure a real CONTROL_PLANE_BACKUP_BUCKET before --enable.\n' >&2
    exit 1
  }
  systemctl enable --now managed-oss-control-plane-backup.timer
  printf 'Enabled managed-oss-control-plane-backup.timer after explicit first-restore proof acknowledgement.\n'
else
  systemctl disable --now managed-oss-control-plane-backup.timer >/dev/null 2>&1 || true
  printf 'Timer installed and disabled. Complete a manual backup and restore-verification drill before enabling it.\n'
fi
