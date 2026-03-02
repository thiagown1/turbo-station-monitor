#!/usr/bin/env node
/**
 * Test Alert Engine
 * Tests detection queries against sample data
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'db', 'logs.db');

console.log('🧪 Testing Alert Engine...\n');

// Ensure database exists
if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Database not found. Run ./create-db.js first');
    process.exit(1);
}

const db = new Database(DB_PATH);

// Insert test data
console.log('📝 Inserting test data...');

const now = Date.now();

// Test 1: Vercel 5xx errors
console.log('\n1️⃣ Testing Vercel 5xx detection...');
const insert = db.prepare(`
    INSERT INTO logs (timestamp, source, endpoint, status_code, duration_ms, meta)
    VALUES (?, 'vercel', '/api/ocpp/webhook', 500, 1234, '{"error":"Internal error"}')
`);

insert.run(now - 60000); // 1 minute ago
insert.run(now - 120000); // 2 minutes ago

const count5xx = db.prepare(`
    SELECT COUNT(*) as count FROM logs 
    WHERE source = 'vercel' 
      AND status_code >= 500 
      AND timestamp > ?
`).get(now - 5 * 60 * 1000);

console.log(`   ✅ Found ${count5xx.count} 5xx errors`);

// Test 2: Vercel timeouts
console.log('\n2️⃣ Testing Vercel timeout detection...');
const insertTimeout = db.prepare(`
    INSERT INTO logs (timestamp, source, endpoint, status_code, duration_ms, meta)
    VALUES (?, 'vercel', '/api/ocpp/start', NULL, 12000, '{"timeout":true}')
`);

insertTimeout.run(now - 90000);

const countTimeouts = db.prepare(`
    SELECT COUNT(*) as count FROM logs 
    WHERE source = 'vercel' 
      AND (status_code IS NULL OR status_code = 0)
      AND duration_ms > 10000
      AND timestamp > ?
`).get(now - 5 * 60 * 1000);

console.log(`   ✅ Found ${countTimeouts.count} timeouts`);

// Test 3: High latency
console.log('\n3️⃣ Testing high latency detection...');
const insertSlow = db.prepare(`
    INSERT INTO logs (timestamp, source, endpoint, status_code, duration_ms, meta)
    VALUES (?, 'vercel', '/api/ocpp/status', 200, ?, '{}')
`);

insertSlow.run(now - 30000, 2500);
insertSlow.run(now - 40000, 3000);
insertSlow.run(now - 50000, 2800);

const countSlow = db.prepare(`
    SELECT COUNT(*) as count FROM logs 
    WHERE source = 'vercel' 
      AND duration_ms > 2000
      AND status_code >= 200 
      AND status_code < 400
      AND timestamp > ?
`).get(now - 5 * 60 * 1000);

console.log(`   ✅ Found ${countSlow.count} slow requests`);

// Test 4: OCPP + Vercel correlation
console.log('\n4️⃣ Testing OCPP+Vercel correlation...');
const insertOcpp = db.prepare(`
    INSERT INTO logs (timestamp, source, charger_id, event_type, meta)
    VALUES (?, 'ocpp', 'AR2510070001', 'charger_faulted', '{"error":"ConnectorLockFailure"}')
`);

const errorTimestamp = now - 2 * 60 * 1000;
insertOcpp.run(errorTimestamp);

const insertVercelError = db.prepare(`
    INSERT INTO logs (timestamp, source, endpoint, status_code, duration_ms, meta)
    VALUES (?, 'vercel', '/api/ocpp/webhook', 503, 890, '{"error":"Service unavailable"}')
`);

insertVercelError.run(errorTimestamp + 10000); // 10s later

// Check correlation
const correlationQuery = `
    SELECT 
        o.charger_id,
        o.event_type,
        o.timestamp as ocpp_ts,
        v.endpoint,
        v.status_code,
        v.timestamp as vercel_ts,
        (v.timestamp - o.timestamp) as time_diff
    FROM logs o
    JOIN logs v ON v.timestamp BETWEEN o.timestamp - 30000 AND o.timestamp + 30000
    WHERE o.source = 'ocpp'
      AND v.source = 'vercel'
      AND v.status_code >= 400
      AND o.event_type LIKE '%fault%'
    LIMIT 5
`;

const correlations = db.prepare(correlationQuery).all();
console.log(`   ✅ Found ${correlations.length} correlations`);

if (correlations.length > 0) {
    correlations.forEach(c => {
        console.log(`      - ${c.charger_id} (${c.event_type}) ↔ ${c.endpoint} (${c.status_code}) [Δ ${c.time_diff}ms]`);
    });
}

// Test the actual AlertEngine
console.log('\n5️⃣ Testing AlertEngine class...');
const AlertEngine = require('./alert-engine');
const engine = new AlertEngine();

console.log('\n   Running detection queries...');

const alerts5xx = engine.detectVercel5xxErrors();
console.log(`   - Vercel 5xx: ${alerts5xx.length} alerts`);

const alertsTimeout = engine.detectVercelTimeouts();
console.log(`   - Timeouts: ${alertsTimeout.length} alerts`);

const alertsLatency = engine.detectHighLatency();
console.log(`   - High latency: ${alertsLatency.length} alerts`);

const alertsCorrelation = engine.detectOcppVercelCorrelation();
console.log(`   - Correlations: ${alertsCorrelation.length} alerts`);

const totalAlerts = alerts5xx.length + alertsTimeout.length + alertsLatency.length + alertsCorrelation.length;
console.log(`\n   📊 Total alerts detected: ${totalAlerts}`);

if (totalAlerts > 0) {
    console.log('\n   📝 Sample alert:');
    const sampleAlert = alerts5xx[0] || alertsTimeout[0] || alertsLatency[0] || alertsCorrelation[0];
    console.log(JSON.stringify(sampleAlert, null, 2));
    
    console.log('\n   📱 Formatted message:');
    const formatted = engine.formatAlertMessage(sampleAlert);
    console.log(formatted.replace(/\\n/g, '\n'));
}

engine.close();

// Database stats
console.log('\n📊 Database Stats:');
const stats = db.prepare(`
    SELECT 
        source,
        COUNT(*) as count,
        MIN(timestamp) as oldest,
        MAX(timestamp) as newest
    FROM logs
    GROUP BY source
`).all();

stats.forEach(s => {
    const age = Math.round((now - s.oldest) / 1000 / 60);
    console.log(`   ${s.source}: ${s.count} logs (oldest: ${age}m ago)`);
});

db.close();

console.log('\n✅ Test complete!');
console.log('\n💡 Next steps:');
console.log('   1. Review alert-engine.js detection logic');
console.log('   2. Start with: pm2 start ecosystem.config.js --only alert-engine');
console.log('   3. Monitor with: pm2 logs alert-engine');
console.log('   4. Check alerts table: node -e "const db=require(\'better-sqlite3\')(\'db/logs.db\');console.log(db.prepare(\'SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5\').all());db.close();"');
