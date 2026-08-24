#!/usr/bin/env bash
set -Eeuo pipefail
set +x

export LC_ALL=C
umask 077

readonly METADATA_TOKEN_URL="http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
readonly BACKUP_CONFIG_FILE="/opt/managed-oss/config/control-plane-backup.env"
readonly MAX_SAFE_DATABASE_BYTES=4000000000000000000

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

on_error() {
  local status=$?
  log "ERROR: backup command failed at line ${BASH_LINENO[0]} (exit $status)"
}
trap on_error ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_root_owned_regular_file() {
  local path="$1"
  local label="$2"
  local owner_id
  local group_id

  [[ -f "$path" && ! -L "$path" ]] || die "$label must be a regular non-symlink file: $path"
  owner_id="$(stat -c '%u' "$path")"
  group_id="$(stat -c '%g' "$path")"
  [[ "$owner_id" == "0" && "$group_id" == "0" ]] || die "$label must be owned by root:root: $path"
}

require_private_root_file() {
  local path="$1"
  local label="$2"
  local mode

  require_root_owned_regular_file "$path" "$label"
  mode="$(stat -c '%a' "$path")"
  if (( 8#$mode & 077 )); then
    die "$label must not be group/world accessible: $path"
  fi
}

require_root_controlled_path() {
  local path="$1"
  local label="$2"
  local owner_id
  local group_id
  local mode

  [[ -e "$path" && ! -L "$path" ]] || die "$label must exist and must not be a symlink: $path"
  owner_id="$(stat -c '%u' "$path")"
  group_id="$(stat -c '%g' "$path")"
  mode="$(stat -c '%a' "$path")"
  [[ "$owner_id" == "0" && "$group_id" == "0" ]] || die "$label must be owned by root:root: $path"
  if (( 8#$mode & 022 )); then
    die "$label must not be group/world writable: $path"
  fi
}

validate_database_bytes() {
  local value="$1"
  local label="$2"

  [[ "$value" =~ ^[1-9][0-9]{0,18}$ ]] || die "$label must be a positive base-10 byte count"
  (( value <= MAX_SAFE_DATABASE_BYTES )) || die "$label exceeds the safe arithmetic limit"
}

usage() {
  cat <<'EOF'
Create a custom-format PostgreSQL control-plane backup, verify its archive,
write a SHA-256 sidecar, and upload both objects to a private GCS bucket.

Configuration is supplied through environment variables. See
control-plane-backup.env.example. No database password or cloud token is
accepted on the command line.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || die "unexpected arguments; use --help"

require_command curl
require_command df
require_command docker
require_command flock
require_command jq
require_command mktemp
require_command sha256sum
require_command stat

backup_bucket="${CONTROL_PLANE_BACKUP_BUCKET:-}"
backup_prefix="${CONTROL_PLANE_BACKUP_PREFIX:-control-plane}"
compose_dir="${CONTROL_PLANE_BACKUP_COMPOSE_DIR:-/opt/managed-oss/config}"
compose_file="${CONTROL_PLANE_BACKUP_COMPOSE_FILE:-docker-compose.yml}"
compose_env_file="${CONTROL_PLANE_BACKUP_COMPOSE_ENV_FILE:-runtime.env}"
work_dir="${CONTROL_PLANE_BACKUP_WORK_DIR:-/opt/managed-oss/backups/control-plane}"
database_service="${CONTROL_PLANE_BACKUP_DATABASE_SERVICE:-database}"
database_name="${CONTROL_PLANE_BACKUP_DATABASE_NAME:-opendock}"
database_user="${CONTROL_PLANE_BACKUP_DATABASE_USER:-opendock}"
max_upload_seconds="${CONTROL_PLANE_BACKUP_MAX_UPLOAD_SECONDS:-1800}"

[[ -n "$backup_bucket" ]] || die "CONTROL_PLANE_BACKUP_BUCKET is required"
[[ ${#backup_bucket} -ge 3 && ${#backup_bucket} -le 222 ]] || die "backup bucket length is invalid"
[[ "$backup_bucket" =~ ^[a-z0-9][a-z0-9._-]*[a-z0-9]$ ]] || die "backup bucket contains unsupported characters"
[[ "$backup_prefix" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "backup prefix contains unsupported characters"
[[ "$backup_prefix" != *".."* && "$backup_prefix" != *"//"* ]] || die "backup prefix contains an unsafe path segment"
backup_prefix="${backup_prefix%/}"
[[ "$compose_file" != */* && "$compose_env_file" != */* ]] || die "compose filenames must be relative to the compose directory"
[[ "$database_service" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "database service name is invalid"
[[ "$database_name" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "database name is invalid"
[[ "$database_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "database user is invalid"
[[ "$max_upload_seconds" =~ ^[0-9]+$ && "$max_upload_seconds" -ge 60 && "$max_upload_seconds" -le 21600 ]] || die "max upload seconds must be between 60 and 21600"

[[ -d "$compose_dir" ]] || die "compose directory does not exist: $compose_dir"
[[ -f "$compose_dir/$compose_file" ]] || die "compose file does not exist: $compose_dir/$compose_file"
[[ -f "$compose_dir/$compose_env_file" ]] || die "compose environment file does not exist: $compose_dir/$compose_env_file"
require_private_root_file "$BACKUP_CONFIG_FILE" "backup configuration file"
require_root_controlled_path "$compose_dir" "compose configuration directory"
require_root_controlled_path "$compose_dir/$compose_file" "compose file"
require_private_root_file "$compose_dir/$compose_env_file" "compose environment file"

install -d -m 0700 "$work_dir"
exec 9>"$work_dir/maintenance.lock"
flock -n 9 || die "another control-plane backup or restore verification is already running"

temp_dir="$(mktemp -d "$work_dir/.backup.XXXXXXXX")"
access_token=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  access_token=""
  rm -rf -- "$temp_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

cd "$compose_dir"
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose --env-file "$compose_env_file" -f "$compose_file")
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  compose=(docker-compose --env-file "$compose_env_file" -f "$compose_file")
else
  die "neither docker compose nor docker-compose is available"
fi

"${compose[@]}" exec -T "$database_service" pg_isready -U "$database_user" -d "$database_name" >/dev/null \
  || die "PostgreSQL service is not ready"

database_bytes="$("${compose[@]}" exec -T "$database_service" psql -XAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database_name" -c 'SELECT pg_database_size(current_database())')"
validate_database_bytes "$database_bytes" "PostgreSQL database size"
available_kib="$(df -Pk "$work_dir" | awk 'NR == 2 { print $4 }')"
[[ "$available_kib" =~ ^[0-9]+$ ]] || die "could not determine backup work-directory capacity"
required_bytes=$((database_bytes * 2 + 536870912))
available_bytes=$((available_kib * 1024))
(( available_bytes >= required_bytes )) || die "insufficient local work space for a safe dump"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -r /proc/sys/kernel/random/uuid ]]; then
  run_id="$(tr -d '-' </proc/sys/kernel/random/uuid | cut -c1-12)"
else
  run_id="$(printf '%012x' "$$")"
fi
[[ "$run_id" =~ ^[a-f0-9]{12}$ ]] || die "could not generate a safe backup identifier"

object_dir="$backup_prefix/${timestamp}_${run_id}"
object_name="$object_dir/${database_name}.dump"
checksum_object_name="$object_name.sha256"
dump_path="$temp_dir/${database_name}.dump"
checksum_path="$dump_path.sha256"

log "creating PostgreSQL custom-format backup"
"${compose[@]}" exec -T "$database_service" pg_dump \
  --format=custom \
  --compress=zstd:6 \
  --no-owner \
  --no-privileges \
  --username "$database_user" \
  --dbname "$database_name" >"$dump_path"

[[ -s "$dump_path" ]] || die "pg_dump produced an empty archive"
[[ "$(head -c 5 "$dump_path")" == "PGDMP" ]] || die "pg_dump output is not a PostgreSQL custom-format archive"
"${compose[@]}" exec -T "$database_service" pg_restore --list <"$dump_path" >/dev/null \
  || die "pg_restore could not read the generated archive"

digest="$(sha256sum "$dump_path" | awk '{ print $1 }')"
[[ "$digest" =~ ^[a-f0-9]{64}$ ]] || die "could not compute archive SHA-256"
printf '%s  %s\n' "$digest" "${database_name}.dump" >"$checksum_path"

server_version="$("${compose[@]}" exec -T "$database_service" psql -XAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database_name" -c 'SHOW server_version')"
server_version="$(printf '%s' "$server_version" | tr -cd 'A-Za-z0-9._ -' | cut -c1-80)"
[[ -n "$server_version" ]] || server_version="unknown"

token_response="$(curl \
  --fail \
  --silent \
  --show-error \
  --retry 3 \
  --retry-all-errors \
  --connect-timeout 3 \
  --max-time 15 \
  --noproxy metadata.google.internal \
  --header 'Metadata-Flavor: Google' \
  "$METADATA_TOKEN_URL")" || die "could not obtain a GCE service-account token"
access_token="$(jq -er '.access_token | select(type == "string" and length > 0)' <<<"$token_response")" \
  || die "metadata token response did not contain an access token"
token_response=""

curl_config="$temp_dir/curl-auth.conf"
printf 'header = "Authorization: Bearer %s"\n' "$access_token" >"$curl_config"
access_token=""

upload_object() {
  local source_path="$1"
  local destination_name="$2"
  local content_type="$3"
  shift 3
  curl \
    --config "$curl_config" \
    --fail-with-body \
    --silent \
    --show-error \
    --retry 5 \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time "$max_upload_seconds" \
    --request PUT \
    --header 'x-goog-if-generation-match: 0' \
    --header "Content-Type: $content_type" \
    "$@" \
    --upload-file "$source_path" \
    --output /dev/null \
    "https://storage.googleapis.com/$backup_bucket/$destination_name"
}

log "uploading immutable backup object to GCS"
upload_object \
  "$dump_path" \
  "$object_name" \
  'application/octet-stream' \
  --header "x-goog-meta-sha256: $digest" \
  --header "x-goog-meta-created-at: $timestamp" \
  --header "x-goog-meta-database-bytes: $database_bytes" \
  --header "x-goog-meta-postgres-version: $server_version"

# The checksum sidecar is uploaded last and acts as the completion marker.
# A dump without its sidecar is incomplete and must never be restored.
upload_object \
  "$checksum_path" \
  "$checksum_object_name" \
  'text/plain' \
  --header "x-goog-meta-sha256: $digest" \
  --header "x-goog-meta-created-at: $timestamp"

archive_bytes="$(stat -c '%s' "$dump_path")"
log "backup complete: gs://$backup_bucket/$object_name"
printf '{"backup":"gs://%s/%s","sha256":"%s","bytes":%s,"databaseBytes":%s,"completedAt":"%s"}\n' \
  "$backup_bucket" "$object_name" "$digest" "$archive_bytes" "$database_bytes" "$timestamp"
