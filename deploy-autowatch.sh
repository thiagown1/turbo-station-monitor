#!/usr/bin/env bash
# deploy-autowatch.sh — Auto-detect a new ocpp_server PROD version from the
# ingested OCPP events (BOOT_NOTIF carries server_version=X.Y.Z) and launch
# deploy-watch.sh (announce + 15min monitor + claude agent report) once per
# new version. Self-contained on OpenClaw — no access to the prod box needed.
# Intended to run from cron every few minutes.
set -u
cd "$(dirname "$0")"
DB=db/ocpp.db
STATE=deploy-autowatch.state
DUR_MIN=15

now_s(){ date +%s; }

# Latest server_version seen in BOOT_NOTIF messages within the last 2h.
CUR=$(sqlite3 "$DB" "SELECT message FROM ocpp_events WHERE message LIKE '%server_version=%' AND timestamp>=$(( ($(now_s)-7200)*1000 )) ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null \
  | grep -oE 'server_version=[0-9.]+' | head -1 | cut -d= -f2)
[ -z "$CUR" ] && exit 0   # no recent version data — nothing to do

LAST=$(cat "$STATE" 2>/dev/null || echo "")

if [ -z "$LAST" ]; then
  # First run: record the current version WITHOUT firing, so we don't announce
  # a deploy that already happened before autowatch was installed.
  echo "$CUR" > "$STATE"
  echo "$(date -u +%FT%TZ) seed state=v$CUR (no fire)"
  exit 0
fi

if [ "$CUR" != "$LAST" ]; then
  echo "$CUR" > "$STATE"
  nohup ./deploy-watch.sh "$CUR" "$DUR_MIN" > "/tmp/deploy-watch-${CUR}.log" 2>&1 &
  echo "$(date -u +%FT%TZ) launched deploy-watch v$CUR (was v$LAST)"
fi
