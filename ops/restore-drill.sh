#!/bin/sh
# Run in a disposable postgres:18 container with the backup repository mounted on /backup.
set -eu
umask 077
source_dir=${1:?Pass a completed /backup/base/TIMESTAMP directory}
case "$source_dir" in /backup/base/*.partial) exit 2 ;; /backup/base/*) ;; *) exit 2 ;; esac
test -f "$source_dir/backup_manifest"
stamp=${source_dir##*/}
printf '%s' "$stamp" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$'
expected_lsn=$(cat "$source_dir.restore-lsn")
printf '%s' "$expected_lsn" | grep -Eq '^[0-9A-F]+/[0-9A-F]+$'
pg_verifybackup "$source_dir"
work=$(mktemp -d)
mkdir "$work/data" "$work/socket"
cp -a "$source_dir"/. "$work/data/"
cat >> "$work/data/postgresql.auto.conf" <<'CONF'
restore_command = 'cp /backup/wal/%f %p'
archive_mode = 'off'
listen_addresses = ''
recovery_target_action = 'promote'
CONF
printf "recovery_target_name = 'mawang_%s'\n" "$stamp" >> "$work/data/postgresql.auto.conf"
touch "$work/data/recovery.signal"
export PGHOST="$work/socket" PGPORT=5544 PGUSER=postgres PGDATABASE=mawang
pg_ctl -D "$work/data" -l "$work/restore.log" -o "-k $PGHOST -p $PGPORT" -w start || { cat "$work/restore.log"; exit 1; }
trap 'pg_ctl -D "$work/data" -m fast -w stop' EXIT
# Wait for replay to finish before counting the restored rounds.
until test "$(psql -XAtc 'select pg_is_in_recovery()')" = f; do
  pg_ctl -D "$work/data" status >/dev/null || { cat "$work/restore.log"; exit 1; }
  sleep 1
done
test "$(psql -XAtc "select coalesce(pg_last_wal_replay_lsn() >= '$expected_lsn'::pg_lsn,false)")" = t
psql -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT (SELECT count(*) FROM accounts) AS accounts,
       (SELECT count(*) FROM game_rooms) AS rooms,
       (SELECT count(*) FROM game_rounds) AS rounds;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM game_rooms g
    WHERE (g.state->>'completed')::integer <>
      (SELECT count(*) FROM game_rounds r WHERE r.room_id=g.id)
  ) THEN RAISE EXCEPTION 'Restored game and settlement counts disagree'; END IF;
END $$;
SQL
