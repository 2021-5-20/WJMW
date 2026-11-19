#!/bin/sh
set -eu
printf '\nhost replication postgres all scram-sha-256\n' >> "$PGDATA/pg_hba.conf"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password MAWANG_DB_PASSWORD
CREATE ROLE mawang_app LOGIN PASSWORD :'app_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO mawang_app;
SQL
