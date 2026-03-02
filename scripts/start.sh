#!/bin/bash
# OCPP Monitor - Smart Collector & Alert System Startup (PM2)

cd "$(dirname "$0")"

echo "🚀 Starting OCPP Monitor System (PM2)..."

# Start with PM2
pm2 start ecosystem.config.js

echo ""
echo "✅ OCPP Monitor System Online"
echo "📊 Tracking: Transactions, Charger Health, User Issues"
echo "📱 Alerts: WhatsApp Group 120363423472541295@g.us"
echo ""
echo "Commands:"
echo "  Status:  pm2 list"
echo "  Logs:    pm2 logs ocpp-collector"
echo "  Stop:    pm2 stop ocpp-collector ocpp-alerts"
echo "  Restart: pm2 restart ocpp-collector ocpp-alerts"
