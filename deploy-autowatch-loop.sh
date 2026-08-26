#!/usr/bin/env bash
cd "$(dirname "$0")"
while true; do ./deploy-autowatch.sh; sleep 180; done
