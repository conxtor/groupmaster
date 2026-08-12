#!/bin/sh
set -eu

db_host="${DB_HOST:-db}"
db_name="${POSTGRES_DB:-app}"
db_user="${DB_USER:-supabase_admin}"
db_password="${POSTGRES_PASSWORD:-app}"
export PGPASSWORD="$db_password"

until pg_isready -h "$db_host" -U "$db_user" -d "$db_name" >/dev/null 2>&1; do
  sleep 2
done

psql_args="-h $db_host -U $db_user -d $db_name -v ON_ERROR_STOP=1"
psql $psql_args -c "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL DEFAULT '', applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"

for file in /migrations/*.sql; do
  version=$(basename "$file" .sql)
  checksum=$(sha256sum "$file" | awk '{print $1}')
  applied_checksum=$(psql $psql_args -Atc "SELECT checksum FROM schema_migrations WHERE version='$version' LIMIT 1")
  if [ -n "$applied_checksum" ]; then
    if [ "$applied_checksum" != "$checksum" ]; then
      echo "Migration checksum mismatch for $version" >&2
      exit 1
    fi
    continue
  fi
  echo "Applying migration $version"
  psql $psql_args -f "$file"
  psql $psql_args -c "INSERT INTO schema_migrations(version, checksum) VALUES ('$version', '$checksum') ON CONFLICT (version) DO UPDATE SET checksum=EXCLUDED.checksum"
done

echo "Database migrations are up to date"
