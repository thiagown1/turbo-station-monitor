#!/usr/bin/env bash
# auto-rollback-watchdog-loop.sh — pm2 entrypoint for the SHADOW-MODE 5xx
# auto-rollback watchdog. Sources the skill .env so DASHBOARD_URL /
# ALERT_TELEGRAM_GROUP / (optional) VERCEL_ROLLBACK_TOKEN are present, then runs
# the watchdog's internal poll loop. The node process owns the cadence (--loop).
cd "$(dirname "$0")/.."
set -a
[ -f .env ] && . ./.env
set +a
exec node services/auto-rollback-watchdog.js --loop
