#!/bin/bash
# Setup cron job for daily database maintenance
# Runs at 03:00 BRT (06:00 UTC) daily

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MAINTENANCE_SCRIPT="$SCRIPT_DIR/daily-maintenance.js"
LOG_DIR="$SCRIPT_DIR/logs"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# BRT is UTC-3, so 03:00 BRT = 06:00 UTC
CRON_TIME="0 6 * * *"

# Create cron job entry
CRON_ENTRY="$CRON_TIME cd $SCRIPT_DIR && /usr/bin/node $MAINTENANCE_SCRIPT >> $LOG_DIR/maintenance.log 2>&1"

echo "📅 Setting up daily maintenance cron job..."
echo "   Time: 03:00 BRT (06:00 UTC)"
echo "   Script: $MAINTENANCE_SCRIPT"
echo "   Log: $LOG_DIR/maintenance.log"
echo ""

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "daily-maintenance.js"; then
    echo "⚠️  Cron job already exists. Removing old entry..."
    crontab -l 2>/dev/null | grep -v "daily-maintenance.js" | crontab -
fi

# Add new cron job
echo "➕ Adding cron job..."
(crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -

echo ""
echo "✅ Cron job installed successfully!"
echo ""
echo "Current crontab:"
crontab -l | grep "daily-maintenance.js"
echo ""
echo "To verify: crontab -l"
echo "To remove: crontab -e (then delete the line)"
echo "To test manually: cd $SCRIPT_DIR && node daily-maintenance.js"
