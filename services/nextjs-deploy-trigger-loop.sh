#!/usr/bin/env bash
cd "$(dirname "$0")/.."
# Load the skill .env so MONITOR_API_SECRET / DASHBOARD_URL are available even
# when started via bare `pm2 start` (not through ecosystem.config.js dotenv).
set -a
[ -f .env ] && . ./.env
set +a
while true; do node services/nextjs-deploy-trigger.js; sleep 60; done
