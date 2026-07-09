#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$HOME/.openclaw/agents"
COMPRESS_DAYS=30
DELETE_DAYS=90

compressed=0
deleted=0

echo "$(date -Iseconds) [rotate-sessions] starting sweep (compress>${COMPRESS_DAYS}d, delete>${DELETE_DAYS}d)"

for sessions_dir in "$AGENTS_DIR"/*/sessions; do
  [ -d "$sessions_dir" ] || continue

  while IFS= read -r -d '' f; do
    [ "$(basename "$f")" = "sessions.json" ] && continue
    rm -f -- "$f"
    deleted=$((deleted+1))
  done < <(find "$sessions_dir" -maxdepth 1 -type f -mtime +${DELETE_DAYS} -print0)

  while IFS= read -r -d '' f; do
    [ "$(basename "$f")" = "sessions.json" ] && continue
    case "$f" in *.gz) continue;; esac
    gzip -q "$f" && compressed=$((compressed+1))
  done < <(find "$sessions_dir" -maxdepth 1 -type f -mtime +${COMPRESS_DAYS} ! -name "*.gz" -print0)
done

echo "$(date -Iseconds) [rotate-sessions] done: compressed=${compressed} deleted=${deleted}"
