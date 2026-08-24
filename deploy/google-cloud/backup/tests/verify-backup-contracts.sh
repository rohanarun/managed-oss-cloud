#!/usr/bin/env bash
set -Eeuo pipefail
set +x

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backup_dir="$(cd -- "$script_dir/.." && pwd -P)"
backup_script="$backup_dir/control-plane-backup.sh"
restore_script="$backup_dir/control-plane-restore-verify.sh"
installer_script="$backup_dir/install.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local expected="$2"

  grep -F -- "$expected" "$file" >/dev/null || fail "$file is missing contract: $expected"
}

assert_file_not_contains() {
  local file="$1"
  local rejected="$2"

  if grep -F -- "$rejected" "$file" >/dev/null; then
    fail "$file contains forbidden contract: $rejected"
  fi
}

assert_rejected_with() {
  local expected="$1"
  shift
  local output
  local status

  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  (( status != 0 )) || fail "command unexpectedly succeeded: $*"
  [[ "$output" == *"$expected"* ]] || fail "command did not reject with expected message: $expected"
}

bash -n "$backup_script"
bash -n "$restore_script"
bash -n "$installer_script"

assert_rejected_with \
  "local archive restores require --source-database-bytes" \
  "$restore_script" --file /tmp/never-read.dump
assert_rejected_with \
  "--source-database-bytes is valid only with --file" \
  "$restore_script" --gcs-object gs://example-bucket/control-plane/example/opendock.dump --source-database-bytes 100
assert_rejected_with \
  "source database bytes must be a positive base-10 byte count" \
  "$restore_script" --file /tmp/never-read.dump --source-database-bytes 0
assert_rejected_with \
  "source database bytes must be a positive base-10 byte count" \
  "$restore_script" --file /tmp/never-read.dump --source-database-bytes 10MiB
assert_rejected_with \
  "source database bytes exceeds the safe arithmetic limit" \
  "$restore_script" --file /tmp/never-read.dump --source-database-bytes 4000000000000000001
assert_rejected_with \
  "Refusing to enable backups before --first-restore-proof-completed" \
  "$installer_script" --enable
assert_rejected_with \
  "--first-restore-proof-completed is valid only with --enable" \
  "$installer_script" --first-restore-proof-completed

parsed_database_bytes="$(
  printf 'HTTP/1.1 200 OK\r\nX-Goog-Meta-Database-Bytes: 123456789\r\n\r\n' |
    awk 'tolower($0) ~ /^x-goog-meta-database-bytes:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value) } END { print value }'
)"
[[ "$parsed_database_bytes" == "123456789" ]] || fail "GCS database-byte metadata parser rejected a valid header"

assert_file_contains "$backup_script" 'x-goog-meta-database-bytes: $database_bytes'
assert_file_contains "$backup_script" '"databaseBytes":%s'
assert_file_contains "$restore_script" 'GCS backup is missing x-goog-meta-database-bytes'
assert_file_contains "$restore_script" "sub(/\\r\$/, \"\", value)"
assert_file_contains "$restore_script" 'required_postgres_bytes=$((source_database_bytes * 2 + 536870912))'
assert_file_contains "$restore_script" '    --head \'
assert_file_not_contains "$restore_script" '    --request HEAD \'
assert_file_contains "$restore_script" '--argjson databaseBytes "$source_database_bytes"'
assert_file_contains "$backup_script" 'require_private_root_file "$BACKUP_CONFIG_FILE" "backup configuration file"'
assert_file_contains "$backup_script" 'require_private_root_file "$compose_dir/$compose_env_file" "compose environment file"'
assert_file_contains "$restore_script" 'require_private_root_file "$BACKUP_CONFIG_FILE" "backup configuration file"'
assert_file_contains "$restore_script" 'require_private_root_file "$compose_dir/$compose_env_file" "compose environment file"'
assert_file_contains "$backup_script" 'if (( 8#$mode & 077 )); then'
assert_file_contains "$restore_script" 'if (( 8#$mode & 077 )); then'
assert_file_not_contains "$backup_script" '(( 8#$mode & 077 )) &&'
assert_file_not_contains "$restore_script" '(( 8#$mode & 077 )) &&'
assert_file_contains "$installer_script" 'chown root:root "$config_file"'
assert_file_contains "$installer_script" 'Refusing to install through a symlinked backup configuration'
assert_file_contains "$installer_script" 'systemctl disable --now managed-oss-control-plane-backup.timer'
assert_file_contains "$installer_script" 'systemctl enable --now managed-oss-control-plane-backup.timer'

printf 'backup contract checks passed\n'
