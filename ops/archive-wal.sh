#!/bin/sh
set -eu
umask 077
source_file=$1
segment=$2
case "$segment" in */*|'') exit 1 ;; esac
mkdir -p /backup/wal
target="/backup/wal/$segment"
if test -f "$target"; then
  cmp -s "$source_file" "$target"
  exit $?
fi
cp "$source_file" "$target.partial"
sync "$target.partial"
mv "$target.partial" "$target"
sync /backup/wal
