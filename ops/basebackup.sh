#!/bin/sh
set -eu
umask 077
mkdir -p /backup/base
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/backup/base/$stamp"
pg_basebackup --no-password --checkpoint=fast --wal-method=stream --format=plain --pgdata="$target.partial"
pg_verifybackup "$target.partial"
point_name="mawang_$stamp"
point=$(psql -XAtq -v ON_ERROR_STOP=1 -v label="$point_name" <<'SQL'
WITH point AS MATERIALIZED (SELECT pg_create_restore_point(:'label') AS lsn)
SELECT lsn,pg_walfile_name(lsn) FROM point;
SQL
)
lsn=${point%|*}
segment=${point#*|}
psql -XAtq -v ON_ERROR_STOP=1 -c 'select pg_switch_wal()' >/dev/null
attempt=0
until test -s "/backup/wal/$segment"; do
  attempt=$((attempt + 1))
  if test "$attempt" -ge 90; then echo "Timed out waiting for archived recovery point $point_name" >&2; exit 1; fi
  sleep 2
done
printf '%s\n' "$lsn" > "$target.restore-lsn"
sync "$target.restore-lsn"
mv "$target.partial" "$target"
sync /backup/base
echo "Verified base backup $stamp"
