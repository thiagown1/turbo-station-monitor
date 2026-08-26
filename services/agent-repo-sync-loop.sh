#!/usr/bin/env bash
# agent-repo-sync-loop.sh — run agent-repo-sync.js forever on a short tick.
# The tick itself is cheap (a queue-offset check); real git activity is paced
# by FALLBACK_INTERVAL_MS inside agent-repo-sync.js, or by a fresh push event.
cd "$(dirname "$0")/.."

export PATH="$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:$PATH"

while true; do
  node services/agent-repo-sync.js
  sleep 60
done
