#!/usr/bin/env bash
set -Eeuo pipefail
set +x

umask 077

die() {
  printf 'Database role configuration refused: %s\n' "$*" >&2
  exit 1
}

compose_dir="${MANAGED_OSS_COMPOSE_DIR:-/opt/managed-oss/config}"
database_service="${MANAGED_OSS_DATABASE_SERVICE:-database}"
database_name="${MANAGED_OSS_DATABASE_NAME:-opendock}"
database_admin_user="${MANAGED_OSS_DATABASE_ADMIN_USER:-opendock}"
password_file="$compose_dir/database-role-passwords.env"

[[ "$compose_dir" == /* && -d "$compose_dir" && ! -L "$compose_dir" ]] || die "the Compose directory must be an absolute non-symlink directory"
[[ "$database_service" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "the database service name is invalid"
[[ "$database_name" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "the database name is invalid"
[[ "$database_admin_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "the database administrator name is invalid"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

compose_bin="${COMPOSE_BIN:-docker-compose}"
compose() {
  (
    cd -- "$compose_dir"
    "$compose_bin" "$@"
  )
}

if [[ ! -e "$password_file" ]]; then
  control_password="$(openssl rand -hex 32)"
  runtime_password="$(openssl rand -hex 32)"
  ai_password="$(openssl rand -hex 32)"
  migrator_password="$(openssl rand -hex 32)"
  temporary_file="$(mktemp "$compose_dir/.database-role-passwords.XXXXXXXX")"
  trap 'rm -f -- "${temporary_file:-}"' EXIT
  cat >"$temporary_file" <<EOF
DATABASE_CONTROL_PASSWORD=$control_password
DATABASE_RUNTIME_PASSWORD=$runtime_password
DATABASE_AI_PASSWORD=$ai_password
DATABASE_MIGRATOR_PASSWORD=$migrator_password
EOF
  chmod 0600 "$temporary_file"
  mv -n -- "$temporary_file" "$password_file" || die "database role password file was created concurrently"
  trap - EXIT
fi

[[ -f "$password_file" && ! -L "$password_file" ]] || die "database role password file must be a regular non-symlink file"
[[ "$(stat -c '%u:%g' "$password_file")" == "0:0" ]] || die "database role password file must be owned by root:root"
mode="$(stat -c '%a' "$password_file")"
(( 8#$mode & 077 )) && die "database role password file must not be group/world accessible"

set -a
# shellcheck disable=SC1090
source "$password_file"
set +a
for variable_name in DATABASE_CONTROL_PASSWORD DATABASE_RUNTIME_PASSWORD DATABASE_AI_PASSWORD DATABASE_MIGRATOR_PASSWORD; do
  value="${!variable_name:-}"
  [[ "$value" =~ ^[a-f0-9]{64}$ ]] || die "$variable_name must be a generated 64-character lowercase hexadecimal secret"
done

compose exec -T "$database_service" psql -X -q -v ON_ERROR_STOP=1 \
  --username "$database_admin_user" \
  --dbname "$database_name" \
  --set=control_password="$DATABASE_CONTROL_PASSWORD" \
  --set=runtime_password="$DATABASE_RUNTIME_PASSWORD" \
  --set=ai_password="$DATABASE_AI_PASSWORD" \
  --set=migrator_password="$DATABASE_MIGRATOR_PASSWORD" <<'SQL'
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_control')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_runtime')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_ai')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_migrator') THEN
    RAISE EXCEPTION 'database privilege migrations must run before login roles are configured';
  END IF;
END
$preflight$;

SELECT pg_catalog.format('CREATE ROLE managed_oss_control_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'control_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_control_login') \gexec
SELECT pg_catalog.format('CREATE ROLE managed_oss_runtime_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_runtime_login') \gexec
SELECT pg_catalog.format('CREATE ROLE managed_oss_ai_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'ai_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_ai_login') \gexec
SELECT pg_catalog.format('CREATE ROLE managed_oss_migrator_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_migrator_login') \gexec

SELECT pg_catalog.format('ALTER ROLE managed_oss_control_login WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'control_password') \gexec
SELECT pg_catalog.format('ALTER ROLE managed_oss_runtime_login WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_password') \gexec
SELECT pg_catalog.format('ALTER ROLE managed_oss_ai_login WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'ai_password') \gexec
SELECT pg_catalog.format('ALTER ROLE managed_oss_migrator_login WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migrator_password') \gexec

GRANT managed_oss_control TO managed_oss_control_login;
GRANT managed_oss_runtime TO managed_oss_runtime_login;
GRANT managed_oss_ai TO managed_oss_ai_login;
GRANT managed_oss_migrator TO managed_oss_migrator_login;

ALTER ROLE managed_oss_control_login SET statement_timeout='30s';
ALTER ROLE managed_oss_runtime_login SET statement_timeout='30s';
ALTER ROLE managed_oss_ai_login SET statement_timeout='120s';
ALTER ROLE managed_oss_migrator_login SET statement_timeout='10min';
SQL

write_private_env() {
  local target="$1"
  local content="$2"
  local temporary
  temporary="$(mktemp "$compose_dir/.$(basename "$target").XXXXXXXX")"
  printf '%s\n' "$content" >"$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$target"
}

write_private_env "$compose_dir/database-control.env" "DATABASE_URL=postgresql://managed_oss_control_login:$DATABASE_CONTROL_PASSWORD@database:5432/$database_name"
write_private_env "$compose_dir/database-suite.env" "DATABASE_RUNTIME_URL=postgresql://managed_oss_runtime_login:$DATABASE_RUNTIME_PASSWORD@database:5432/$database_name"
write_private_env "$compose_dir/database-ai.env" "DATABASE_AI_URL=postgresql://managed_oss_ai_login:$DATABASE_AI_PASSWORD@database:5432/$database_name"
write_private_env "$compose_dir/database-migrator.env" "DATABASE_MIGRATOR_URL=postgresql://managed_oss_migrator_login:$DATABASE_MIGRATOR_PASSWORD@database:5432/$database_name"

verify_login() {
  local role_name="$1"
  local password="$2"
  printf '%s\n' "$password" | compose exec -T "$database_service" sh -ceu '
    IFS= read -r PGPASSWORD
    export PGPASSWORD
    result="$(psql -XAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d "$2" -c "SELECT current_user")"
    test "$result" = "$1"
  ' sh "$role_name" "$database_name"
}

verify_login managed_oss_control_login "$DATABASE_CONTROL_PASSWORD"
verify_login managed_oss_runtime_login "$DATABASE_RUNTIME_PASSWORD"
verify_login managed_oss_ai_login "$DATABASE_AI_PASSWORD"
verify_login managed_oss_migrator_login "$DATABASE_MIGRATOR_PASSWORD"

compose exec -T "$database_service" psql -XAt -v ON_ERROR_STOP=1 --username "$database_admin_user" --dbname "$database_name" <<'SQL' | grep -qx '4'
SELECT COUNT(*)
FROM pg_catalog.pg_roles
WHERE rolname IN ('managed_oss_control_login','managed_oss_runtime_login','managed_oss_ai_login','managed_oss_migrator_login')
  AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls;
SQL

printf 'Configured four least-privilege PostgreSQL login roles and isolated service credential files.\n'
