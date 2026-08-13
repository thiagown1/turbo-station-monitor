#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$HOME/.openclaw/agents"
COMPRESS_DAYS=30
DELETE_DAYS=90
# Never remove a checkpoint young enough to belong to an in-flight compaction.
ORPHAN_MIN_AGE_MIN=60

compressed=0
deleted=0
orphans=0

echo "$(date -Iseconds) [rotate-sessions] starting sweep (compress>${COMPRESS_DAYS}d, delete>${DELETE_DAYS}d, orphan-checkpoints>${ORPHAN_MIN_AGE_MIN}min)"

store_refs() {
  local store="$1"
  [ -f "$store" ] || return 0
  python3 - "$store" <<'PY'
import json, os, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
out = set()
def walk(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "sessionFile" and isinstance(value, str) and ".checkpoint." in value:
                base = os.path.basename(value.strip())
                out.add(base)
                out.add(base + ".gz")
            else:
                walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
walk(data)
print("\n".join(sorted(out)))
PY
}

for sessions_dir in "$AGENTS_DIR"/*/sessions; do
  [ -d "$sessions_dir" ] || continue

  keep_file=$(mktemp)
  if ! store_refs "$sessions_dir/sessions.json" > "$keep_file"; then
    echo "$(date -Iseconds) [rotate-sessions] WARN unreadable sessions.json, skipping $sessions_dir"
    rm -f "$keep_file"
    continue
  fi

  while IFS= read -r -d '' f; do
    if grep -qxF "$(basename "$f")" "$keep_file"; then continue; fi
    rm -f -- "$f"
    orphans=$((orphans+1))
  done < <(find "$sessions_dir" -maxdepth 1 -type f -name "*.checkpoint.*" -mmin +${ORPHAN_MIN_AGE_MIN} -print0)

  while IFS= read -r -d '' f; do
    [ "$(basename "$f")" = "sessions.json" ] && continue
    if grep -qxF "$(basename "$f")" "$keep_file"; then continue; fi
    rm -f -- "$f"
    deleted=$((deleted+1))
  done < <(find "$sessions_dir" -maxdepth 1 -type f -mtime +${DELETE_DAYS} -print0)

  while IFS= read -r -d '' f; do
    [ "$(basename "$f")" = "sessions.json" ] && continue
    case "$f" in *.gz) continue;; esac
    if grep -qxF "$(basename "$f")" "$keep_file"; then continue; fi
    gzip -q "$f" && compressed=$((compressed+1))
  done < <(find "$sessions_dir" -maxdepth 1 -type f -mtime +${COMPRESS_DAYS} ! -name "*.gz" -print0)

  rm -f "$keep_file"
done

echo "$(date -Iseconds) [rotate-sessions] done: compressed=${compressed} deleted=${deleted} orphan-checkpoints=${orphans}"
