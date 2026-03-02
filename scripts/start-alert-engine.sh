#!/bin/bash
# Start Alert Engine with PM2

echo "🚀 Starting Alert Engine..."

# Check if database exists
if [ ! -f "db/logs.db" ]; then
    echo "❌ Database not found. Run ./create-db.js first"
    exit 1
fi

# Ensure history directory exists
mkdir -p history

# Start with PM2
pm2 start ecosystem.config.js --only alert-engine

echo ""
echo "✅ Alert Engine started!"
echo ""
echo "📊 Monitor with:"
echo "   pm2 logs alert-engine"
echo ""
echo "🔍 Check status:"
echo "   pm2 status alert-engine"
echo ""
echo "📝 View alerts:"
echo "   node -e \"const db=require('better-sqlite3')('db/logs.db');console.log(db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5').all());db.close();\""
