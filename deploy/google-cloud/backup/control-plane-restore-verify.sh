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
  log "ERROR: restore-verification command failed at line ${BASH_LINENO[0]} (exit $status)"
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
Verify a control-plane PostgreSQL backup without touching the production
database. The command checks the SHA-256 sidecar and custom archive, restores
into a uniquely named temporary database, runs catalog checks, and drops the
temporary database on every exit path.

Usage:
  control-plane-restore-verify.sh --gcs-object gs://BUCKET/PREFIX/opendock.dump
  control-plane-restore-verify.sh --file /secure/path/opendock.dump \
    --source-database-bytes BYTES [--sha-file FILE]

Optional deployment arguments:
  --compose-dir DIR       Default: /opt/managed-oss/config
  --compose-file FILE     Default: docker-compose.yml
  --compose-env-file FILE Default: runtime.env
  --database-service NAME Default: database
  --database-user NAME    Default: opendock
  --database-name NAME    Default: opendock
  --work-dir DIR          Default: /opt/managed-oss/backups/control-plane

The GCS form obtains a short-lived token from the GCE metadata service. Cloud
tokens and database passwords are never accepted as command-line arguments.
EOF
}

gcs_uri=""
local_file=""
local_checksum_file=""
source_database_bytes=""
compose_dir="${CONTROL_PLANE_BACKUP_COMPOSE_DIR:-/opt/managed-oss/config}"
compose_file="${CONTROL_PLANE_BACKUP_COMPOSE_FILE:-docker-compose.yml}"
compose_env_file="${CONTROL_PLANE_BACKUP_COMPOSE_ENV_FILE:-runtime.env}"
work_dir="${CONTROL_PLANE_BACKUP_WORK_DIR:-/opt/managed-oss/backups/control-plane}"
postgres_data_dir="${CONTROL_PLANE_BACKUP_POSTGRES_DATA_DIR:-/opt/managed-oss/apps/postgres}"
database_service="${CONTROL_PLANE_BACKUP_DATABASE_SERVICE:-database}"
database_user="${CONTROL_PLANE_BACKUP_DATABASE_USER:-opendock}"
database_name="${CONTROL_PLANE_BACKUP_DATABASE_NAME:-opendock}"
max_download_seconds="${CONTROL_PLANE_BACKUP_MAX_DOWNLOAD_SECONDS:-1800}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gcs-object)
      [[ $# -ge 2 ]] || die "--gcs-object requires a value"
      gcs_uri="$2"
      shift 2
      ;;
    --file)
      [[ $# -ge 2 ]] || die "--file requires a value"
      local_file="$2"
      shift 2
      ;;
    --sha-file)
      [[ $# -ge 2 ]] || die "--sha-file requires a value"
      local_checksum_file="$2"
      shift 2
      ;;
    --source-database-bytes)
      [[ $# -ge 2 ]] || die "--source-database-bytes requires a value"
      source_database_bytes="$2"
      shift 2
      ;;
    --compose-dir)
      [[ $# -ge 2 ]] || die "--compose-dir requires a value"
      compose_dir="$2"
      shift 2
      ;;
    --compose-file)
      [[ $# -ge 2 ]] || die "--compose-file requires a value"
      compose_file="$2"
      shift 2
      ;;
    --compose-env-file)
      [[ $# -ge 2 ]] || die "--compose-env-file requires a value"
      compose_env_file="$2"
      shift 2
      ;;
    --database-service)
      [[ $# -ge 2 ]] || die "--database-service requires a value"
      database_service="$2"
      shift 2
      ;;
    --database-user)
      [[ $# -ge 2 ]] || die "--database-user requires a value"
      database_user="$2"
      shift 2
      ;;
    --database-name)
      [[ $# -ge 2 ]] || die "--database-name requires a value"
      database_name="$2"
      shift 2
      ;;
    --work-dir)
      [[ $# -ge 2 ]] || die "--work-dir requires a value"
      work_dir="$2"
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

if [[ -n "$gcs_uri" && -n "$local_file" ]]; then
  die "choose exactly one of --gcs-object or --file"
fi
[[ -n "$gcs_uri" || -n "$local_file" ]] || die "--gcs-object or --file is required"
[[ -z "$local_checksum_file" || -n "$local_file" ]] || die "--sha-file is valid only with --file"
[[ -z "$source_database_bytes" || -n "$local_file" ]] || die "--source-database-bytes is valid only with --file"
[[ -z "$local_file" || -n "$source_database_bytes" ]] || die "local archive restores require --source-database-bytes from the trusted backup record"
if [[ -n "$source_database_bytes" ]]; then
  validate_database_bytes "$source_database_bytes" "source database bytes"
fi
[[ "$compose_file" != */* && "$compose_env_file" != */* ]] || die "compose filenames must be relative to the compose directory"
[[ "$database_service" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "database service name is invalid"
[[ "$database_name" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "database name is invalid"
[[ "$database_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "database user is invalid"
[[ "$max_download_seconds" =~ ^[0-9]+$ && "$max_download_seconds" -ge 60 && "$max_download_seconds" -le 21600 ]] || die "max download seconds must be between 60 and 21600"

require_command df
require_command docker
require_command flock
require_command jq
require_command mktemp
require_command sha256sum
require_command stat

[[ -d "$compose_dir" ]] || die "compose directory does not exist: $compose_dir"
[[ -f "$compose_dir/$compose_file" ]] || die "compose file does not exist: $compose_dir/$compose_file"
[[ -f "$compose_dir/$compose_env_file" ]] || die "compose environment file does not exist: $compose_dir/$compose_env_file"
[[ -d "$postgres_data_dir" ]] || die "PostgreSQL data directory does not exist: $postgres_data_dir"
require_private_root_file "$BACKUP_CONFIG_FILE" "backup configuration file"
require_root_controlled_path "$compose_dir" "compose configuration directory"
require_root_controlled_path "$compose_dir/$compose_file" "compose file"
require_private_root_file "$compose_dir/$compose_env_file" "compose environment file"

install -d -m 0700 "$work_dir"
exec 9>"$work_dir/maintenance.lock"
flock -n 9 || die "another control-plane backup or restore verification is already running"

temp_dir="$(mktemp -d "$work_dir/.restore-verify.XXXXXXXX")"
access_token=""
verify_database=""
database_created=0
compose=()

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  access_token=""
  if (( database_created == 1 )) && [[ -n "$verify_database" ]] && (( ${#compose[@]} > 0 )); then
    set +e
    if ! "${compose[@]}" exec -T "$database_service" dropdb \
      --if-exists \
      --force \
      --username "$database_user" \
      "$verify_database" >/dev/null 2>&1; then
      log "ERROR: could not remove temporary verification database: $verify_database"
    fi
    set -e
  fi
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

archive_path="$local_file"
checksum_path="$local_checksum_file"
source_label="local"

if [[ -n "$gcs_uri" ]]; then
  require_command curl
  [[ "$gcs_uri" == gs://* ]] || die "GCS object must use a gs:// URI"
  gcs_path="${gcs_uri#gs://}"
  backup_bucket="${gcs_path%%/*}"
  object_name="${gcs_path#*/}"
  [[ -n "$backup_bucket" && "$object_name" != "$gcs_path" && -n "$object_name" ]] || die "GCS object URI is incomplete"
  [[ ${#backup_bucket} -ge 3 && ${#backup_bucket} -le 222 ]] || die "backup bucket length is invalid"
  [[ "$backup_bucket" =~ ^[a-z0-9][a-z0-9._-]*[a-z0-9]$ ]] || die "backup bucket contains unsupported characters"
  [[ "$object_name" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*\.dump$ ]] || die "GCS object must be a safe .dump path"
  [[ "$object_name" != *".."* && "$object_name" != *"//"* ]] || die "GCS object contains an unsafe path segment"

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

  archive_path="$temp_dir/restore.dump"
  checksum_path="$temp_dir/restore.dump.sha256"
  archive_headers="$temp_dir/archive.headers"

  curl \
    --config "$curl_config" \
    --fail-with-body \
    --silent \
    --show-error \
    --retry 3 \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time 60 \
    --head \
    --dump-header "$archive_headers" \
    --output /dev/null \
    "https://storage.googleapis.com/$backup_bucket/$object_name"
  object_bytes="$(awk 'tolower($0) ~ /^content-length:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value) } END { print value }' "$archive_headers")"
  [[ "$object_bytes" =~ ^[0-9]+$ && "$object_bytes" -gt 0 ]] || die "GCS object did not report a valid content length"
  source_database_bytes="$(awk 'tolower($0) ~ /^x-goog-meta-database-bytes:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value) } END { print value }' "$archive_headers")"
  [[ -n "$source_database_bytes" ]] || die "GCS backup is missing x-goog-meta-database-bytes"
  validate_database_bytes "$source_database_bytes" "GCS source database bytes"
  work_available_kib="$(df -Pk "$work_dir" | awk 'NR == 2 { print $4 }')"
  [[ "$work_available_kib" =~ ^[0-9]+$ ]] || die "could not determine restore work-directory capacity"
  (( work_available_kib * 1024 >= object_bytes + 536870912 )) || die "insufficient local work space to download the backup"

  log "downloading backup and checksum sidecar from GCS"
  curl \
    --config "$curl_config" \
    --fail-with-body \
    --silent \
    --show-error \
    --retry 5 \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time "$max_download_seconds" \
    --output "$archive_path" \
    "https://storage.googleapis.com/$backup_bucket/$object_name"
  curl \
    --config "$curl_config" \
    --fail-with-body \
    --silent \
    --show-error \
    --retry 5 \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time 120 \
    --output "$checksum_path" \
    "https://storage.googleapis.com/$backup_bucket/$object_name.sha256"
  source_label="$gcs_uri"
else
  [[ -f "$archive_path" && ! -L "$archive_path" ]] || die "local archive must be a regular non-symlink file"
  if [[ -z "$checksum_path" ]]; then
    checksum_path="$archive_path.sha256"
  fi
  [[ -f "$checksum_path" && ! -L "$checksum_path" ]] || die "checksum sidecar must be a regular non-symlink file"
fi

[[ -s "$archive_path" ]] || die "backup archive is empty"
[[ "$(head -c 5 "$archive_path")" == "PGDMP" ]] || die "backup is not a PostgreSQL custom-format archive"
read -r expected_digest checksum_filename checksum_extra <"$checksum_path" || die "could not read checksum sidecar"
[[ "$expected_digest" =~ ^[a-f0-9]{64}$ ]] || die "checksum sidecar does not contain a SHA-256 digest"
[[ -n "$checksum_filename" && -z "${checksum_extra:-}" ]] || die "checksum sidecar has an invalid format"
[[ "$checksum_filename" == "$(basename "$archive_path")" || "$checksum_filename" == "${database_name}.dump" ]] \
  || die "checksum sidecar names a different archive"
actual_digest="$(sha256sum "$archive_path" | awk '{ print $1 }')"
[[ "$actual_digest" == "$expected_digest" ]] || die "backup SHA-256 verification failed"
"${compose[@]}" exec -T "$database_service" pg_restore --list <"$archive_path" >/dev/null \
  || die "pg_restore could not read the backup archive"

postgres_available_kib="$(df -Pk "$postgres_data_dir" | awk 'NR == 2 { print $4 }')"
[[ "$postgres_available_kib" =~ ^[0-9]+$ ]] || die "could not determine PostgreSQL data-volume capacity"
required_postgres_bytes=$((source_database_bytes * 2 + 536870912))
(( postgres_available_kib * 1024 >= required_postgres_bytes )) \
  || die "insufficient PostgreSQL data-volume capacity for an isolated verification restore"

timestamp="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
verify_database="restore_verify_${timestamp}_$$_${RANDOM}"
verify_database="${verify_database:0:63}"
[[ "$verify_database" =~ ^restore_verify_[a-z0-9_]+$ && "$verify_database" != "$database_name" ]] \
  || die "generated verification database name is unsafe"

existing_database="$("${compose[@]}" exec -T "$database_service" psql -XAt -v ON_ERROR_STOP=1 -U "$database_user" -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$verify_database'")"
[[ -z "$existing_database" ]] || die "generated verification database already exists"

started_epoch="$(date +%s)"
log "restoring into isolated temporary database"
database_created=1
"${compose[@]}" exec -T "$database_service" createdb \
  --username "$database_user" \
  --template template0 \
  "$verify_database"

"${compose[@]}" exec -T "$database_service" pg_restore \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --username "$database_user" \
  --dbname "$verify_database" <"$archive_path" >/dev/null

schema_count="$("${compose[@]}" exec -T "$database_service" psql -XAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$verify_database" -c "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_toast%'")"
table_count="$("${compose[@]}" exec -T "$database_service" psql -XAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$verify_database" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'")"
invalid_index_count="$("${compose[@]}" exec -T "$database_service" psql -XAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$verify_database" -c 'SELECT count(*) FROM pg_index WHERE NOT indisvalid')"
[[ "$schema_count" =~ ^[0-9]+$ && "$schema_count" -gt 0 ]] || die "verification restore contains no user schemas"
[[ "$table_count" =~ ^[0-9]+$ && "$table_count" -gt 0 ]] || die "verification restore contains no user tables"
[[ "$invalid_index_count" == "0" ]] || die "verification restore contains invalid indexes"

finished_epoch="$(date +%s)"
duration_seconds=$((finished_epoch - started_epoch))
log "restore verification passed; removing temporary database"
"${compose[@]}" exec -T "$database_service" dropdb \
  --if-exists \
  --force \
  --username "$database_user" \
  "$verify_database"
database_created=0
log "restore verification complete"
jq -cn \
  --arg source "$source_label" \
  --arg sha256 "$actual_digest" \
  --argjson schemas "$schema_count" \
  --argjson tables "$table_count" \
  --argjson databaseBytes "$source_database_bytes" \
  --argjson durationSeconds "$duration_seconds" \
  '{
    verified: true,
    source: $source,
    sha256: $sha256,
    schemas: $schemas,
    tables: $tables,
    databaseBytes: $databaseBytes,
    invalidIndexes: 0,
    durationSeconds: $durationSeconds
  }'
