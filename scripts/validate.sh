#!/bin/bash
# OCPP Monitor Validation Script

echo "🧪 OCPP Monitor System Validation"
echo "=================================="
echo ""

# 1. Process Health
echo "1️⃣ Process Health"
echo "-------------------"
pm2 list | grep -E "ocpp-collector|alert-engine"
echo ""

# 2. Charger Tracking
echo "2️⃣ Charger Tracking"
echo "-------------------"
python3 << 'EOF'
import json

with open('history/chargers.json') as f:
    chargers = json.load(f)

total = len(chargers)
needs_restart = [c for c in chargers.values() if c.get('needsRestart')]
faulted = [c for c in chargers.values() if c.get('status') == 'Faulted']
charging = [c for c in chargers.values() if c.get('status') == 'Charging']

print(f"✅ Total chargers tracked: {total}")
print(f"⚠️  Needs restart: {len(needs_restart)}")
if needs_restart:
    for c in needs_restart:
        print(f"   - {c['id']}: {c['restartReason']}")
print(f"🔴 Faulted: {len(faulted)}")
if faulted:
    for c in faulted:
        print(f"   - {c['id']}")
print(f"⚡ Charging: {len(charging)}")
EOF
echo ""

# 3. Event Collection
echo "3️⃣ Event Collection"
echo "-------------------"
EVENT_COUNT=$(cat history/events_buffer.json | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
LAST_EVENT=$(cat history/events_buffer.json | python3 -c "import json,sys; events=json.load(sys.stdin); print(events[-1]['ts'] if events else 'None')")
echo "✅ Events in buffer: $EVENT_COUNT"
echo "🕐 Last event: $LAST_EVENT"
echo ""

# 4. Alert System
echo "4️⃣ Alert System"
echo "-------------------"
echo "WhatsApp alerts are sent by alert-engine (the ocpp-alerts queue was retired)."
echo "Check with: pm2 logs alert-engine --lines 50"
echo ""

# 5. WebSocket Connection
echo "5️⃣ WebSocket Connection"
echo "-------------------"
CONNECTS=$(tail -20 logs/collector-out.log | grep -c "Connected" || echo "0")
DISCONNECTS=$(tail -20 logs/collector-out.log | grep -c "Disconnected" || echo "0")
echo "🔌 Recent connects: $CONNECTS (last 20 lines)"
echo "❌ Recent disconnects: $DISCONNECTS (last 20 lines)"

if [ $DISCONNECTS -gt 10 ]; then
    echo "⚠️  WARNING: WebSocket is unstable!"
else
    echo "✅ WebSocket looks stable"
fi
echo ""

# 6. Last Alert Sent
echo "6️⃣ Last Alert Sent to WhatsApp"
echo "-------------------"
echo "Check with: pm2 logs alert-engine --lines 50 | grep -i whatsapp"
echo ""

# 7. Recommendations
echo "7️⃣ Recommendations"
echo "-------------------"
if [ $DISCONNECTS -gt 10 ]; then
    echo "❌ Fix WebSocket connection (reconnecting too often)"
fi


python3 << 'EOF'
import json
from datetime import datetime, timedelta

with open('history/chargers.json') as f:
    chargers = json.load(f)

stale = []
for cid, c in chargers.items():
    if c.get('lastHeartbeat'):
        last = datetime.fromisoformat(c['lastHeartbeat'].replace('Z', '+00:00'))
        age = datetime.now(last.tzinfo) - last
        if age > timedelta(minutes=10):
            stale.append((cid, age.seconds // 60))

if stale:
    print("⚠️  Chargers with stale heartbeats (>10min):")
    for cid, mins in stale[:5]:
        print(f"   - {cid}: {mins}min ago")
else:
    print("✅ All chargers have recent heartbeats")
EOF

echo ""
echo "=================================="
echo "✅ Validation Complete"
