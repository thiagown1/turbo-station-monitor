#!/bin/bash
echo "🔍 Verifying Phase 4 Implementation..."
echo ""

# Check files exist
echo "📁 Files:"
FILES=("alert-engine.js" "test-alert-engine.js" "start-alert-engine.sh" "ALERT_ENGINE.md" "PHASE4_SUMMARY.md")
for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "  ✅ $file"
    else
        echo "  ❌ $file MISSING"
    fi
done

echo ""
echo "📊 Database:"
if [ -f "db/logs.db" ]; then
    echo "  ✅ db/logs.db exists"
    
    # Check alerts table
    node -e "
        const db = require('better-sqlite3')('db/logs.db');
        const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
        const hasAlerts = tables.some(t => t.name === 'alerts');
        console.log(hasAlerts ? '  ✅ alerts table exists' : '  ❌ alerts table missing');
        db.close();
    "
else
    echo "  ❌ db/logs.db MISSING"
fi

echo ""
echo "⚙️  PM2 Config:"
if grep -q "alert-engine" ecosystem.config.js; then
    echo "  ✅ alert-engine in ecosystem.config.js"
    if grep -q "cron_restart" ecosystem.config.js; then
        echo "  ✅ cron_restart configured"
    else
        echo "  ❌ cron_restart missing"
    fi
else
    echo "  ❌ alert-engine not in ecosystem.config.js"
fi

echo ""
echo "📝 Documentation:"
if grep -q "Fase 4.*COMPLETO" INTEGRATION.md; then
    echo "  ✅ INTEGRATION.md updated"
else
    echo "  ❌ INTEGRATION.md not updated"
fi

echo ""
echo "🧪 Running quick test..."
if node alert-engine.js > /dev/null 2>&1; then
    echo "  ✅ alert-engine.js executes without errors"
else
    echo "  ⚠️  alert-engine.js has errors (check manually)"
fi

echo ""
echo "✅ Phase 4 verification complete!"
echo ""
echo "🚀 To deploy: ./start-alert-engine.sh"
