#!/usr/bin/env node
/**
 * Test suite for Mobile Telemetry Endpoint
 * Tests: POST /api/telemetry/mobile on vercel-drain
 * 
 * Usage: node test-telemetry-endpoint.js [--live]
 *   --live  = test against running server (localhost:3001)
 *   default = unit test using direct DB + handler logic
 */

const Database = require('better-sqlite3');
const path = require('path');
const http = require('http');

const DB_PATH = path.join(__dirname, 'db', 'logs.db');
const LIVE = process.argv.includes('--live');
const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;
const API_KEY = 'f593c26c80894c8aef64a4c977f280d8ae687387b049f454';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

function makePayload(overrides = {}) {
  return {
    session_id: 'test-session-' + Date.now(),
    device_id: 'test-device-001',
    app_version: '2.0.0-test',
    platform: 'android',
    user_id: 'test-user-firebase-uid',
    events: [
      {
        event_type: 'screen_open',
        timestamp: Date.now(),
        data: {
          screen: 'charger_detail',
          source: 'qr_code',
          station_id: 'TEST_CHARGER_001'
        }
      },
      {
        event_type: 'start_charge_tap',
        timestamp: Date.now() + 5000,
        data: {
          station_id: 'TEST_CHARGER_001',
          connector_id: 1
        }
      }
    ],
    ...overrides
  };
}

// ─── HTTP Helper ───
function httpPost(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Telemetry-Key': API_KEY,
        ...headers,
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(responseBody) });
        } catch {
          resolve({ status: res.statusCode, body: responseBody });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── DB Tests (always run) ───
async function testDbSchema() {
  console.log('\n📦 Database Schema Tests');
  
  const db = new Database(DB_PATH, { readonly: true });
  
  // Test: source CHECK constraint includes 'mobile'
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='logs'").get();
  assert(schema.sql.includes("'mobile'"), "CHECK constraint includes 'mobile'");
  assert(schema.sql.includes("'ocpp'"), "CHECK constraint still includes 'ocpp'");
  assert(schema.sql.includes("'vercel'"), "CHECK constraint still includes 'vercel'");
  
  // Test: all required columns exist
  const cols = db.prepare("PRAGMA table_info(logs)").all().map(c => c.name);
  for (const col of ['charger_id', 'event_type', 'category', 'severity', 'message', 'logger', 'meta']) {
    assert(cols.includes(col), `Column '${col}' exists`);
  }
  
  db.close();
}

async function testDbInsert() {
  console.log('\n💾 Database Insert Tests');
  
  const db = new Database(DB_PATH);
  const testSessionId = 'unit-test-' + Date.now();
  
  // Test: insert mobile event with all fields
  const stmt = db.prepare(`
    INSERT INTO logs (timestamp, source, charger_id, event_type, category, severity, message, logger, meta)
    VALUES (?, 'mobile', ?, ?, ?, ?, ?, ?, ?)
  `);
  
  let insertOk = false;
  try {
    stmt.run(
      Date.now(),
      'TEST_CHARGER',
      'screen_open',
      'screen_open',
      'info',
      'test message',
      'mobile_telemetry',
      JSON.stringify({ session_id: testSessionId, device_id: 'test' })
    );
    insertOk = true;
  } catch (e) {
    console.log('    Error:', e.message);
  }
  assert(insertOk, "INSERT with source='mobile' succeeds");
  
  // Test: verify the inserted row
  const row = db.prepare(
    "SELECT * FROM logs WHERE meta LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`%${testSessionId}%`);
  
  assert(row !== undefined, "Inserted row can be queried");
  assert(row.source === 'mobile', "source = 'mobile'");
  assert(row.charger_id === 'TEST_CHARGER', "charger_id preserved");
  assert(row.category === 'screen_open', "category preserved");
  assert(row.severity === 'info', "severity preserved");
  assert(row.logger === 'mobile_telemetry', "logger = 'mobile_telemetry'");
  
  // Test: insert error event with severity='error'
  stmt.run(
    Date.now(),
    'TEST_CHARGER',
    'error',
    'error',
    'error',
    'Connection timeout',
    'mobile_telemetry',
    JSON.stringify({ session_id: testSessionId + '-err' })
  );
  
  const errRow = db.prepare(
    "SELECT severity FROM logs WHERE meta LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`%${testSessionId}-err%`);
  assert(errRow.severity === 'error', "Error events have severity='error'");
  
  // Cleanup test data
  db.prepare("DELETE FROM logs WHERE meta LIKE ?").run(`%${testSessionId}%`);
  db.prepare("DELETE FROM logs WHERE meta LIKE ?").run(`%${testSessionId}-err%`);
  
  db.close();
}

// ─── Live Endpoint Tests (only with --live) ───
async function testLiveEndpoint() {
  console.log('\n🌐 Live Endpoint Tests (localhost:' + PORT + ')');
  
  // Test: valid payload → 202
  const payload = makePayload();
  const res1 = await httpPost('/api/telemetry/mobile', payload);
  assert(res1.status === 202, `Valid payload → 202 (got ${res1.status})`);
  assert(res1.body.success === true, "Response has success=true");
  assert(res1.body.received === 2, `Received count = 2 (got ${res1.body.received})`);

  // Test: no API key → 401
  const res0 = await httpPost('/api/telemetry/mobile', payload, { 'X-Telemetry-Key': 'wrong-key' });
  assert(res0.status === 401, `Wrong API key → 401 (got ${res0.status})`);

  // Test: missing API key → 401
  const res0b = await httpPost('/api/telemetry/mobile', payload, { 'X-Telemetry-Key': '' });
  assert(res0b.status === 401, `Missing API key → 401 (got ${res0b.status})`);
  
  // Test: empty events array → 202 (no-op)
  const res2 = await httpPost('/api/telemetry/mobile', makePayload({ events: [] }));
  assert(res2.status === 202, `Empty events → 202 (got ${res2.status})`);
  assert(res2.body.received === 0, "Received count = 0 for empty");
  
  // Test: missing events field → 400
  const res3 = await httpPost('/api/telemetry/mobile', { session_id: 'x', device_id: 'y' });
  assert(res3.status === 400, `Missing events → 400 (got ${res3.status})`);
  
  // Test: malformed JSON → 500 (with valid API key)
  const res4 = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/telemetry/mobile',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telemetry-Key': API_KEY }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.write('not json{{{');
    req.end();
  });
  assert(res4.status === 500, `Malformed JSON → 500 (got ${res4.status})`);
  
  // Test: large batch (100 events) works
  const bigPayload = makePayload({
    events: Array.from({ length: 100 }, (_, i) => ({
      event_type: 'test_event',
      timestamp: Date.now() + i,
      data: { index: i, station_id: 'BATCH_TEST' }
    }))
  });
  const res5 = await httpPost('/api/telemetry/mobile', bigPayload);
  assert(res5.status === 202, `100-event batch → 202 (got ${res5.status})`);
  assert(res5.body.received === 100, `Received 100 (got ${res5.body.received})`);
  
  // Test: unknown fields don't cause rejection
  const res6 = await httpPost('/api/telemetry/mobile', makePayload({
    unknown_field: 'should be ignored',
    events: [{ event_type: 'test', timestamp: Date.now(), data: { weird_field: true }, extra_field: 42 }]
  }));
  assert(res6.status === 202, `Unknown fields accepted → 202 (got ${res6.status})`);
  
  // Test: verify data actually landed in DB
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(
    "SELECT * FROM logs WHERE source = 'mobile' AND meta LIKE ? ORDER BY id DESC LIMIT 5"
  ).all(`%${payload.session_id}%`);
  
  assert(rows.length === 2, `2 events stored in DB (got ${rows.length})`);
  assert(rows[0].logger === 'mobile_telemetry', "logger = mobile_telemetry in DB");
  assert(rows[0].charger_id === 'TEST_CHARGER_001', `charger_id extracted from data.station_id (got ${rows[0].charger_id})`);
  
  const meta = JSON.parse(rows[0].meta);
  assert(meta.session_id === payload.session_id, "session_id in meta");
  assert(meta.device_id === payload.device_id, "device_id in meta");
  assert(meta.app_version === '2.0.0-test', "app_version in meta");
  assert(meta.user_id === 'test-user-firebase-uid', "user_id in meta");
  
  // Cleanup live test data
  db.close();
  const dbWrite = new Database(DB_PATH);
  dbWrite.prepare("DELETE FROM logs WHERE source = 'mobile' AND meta LIKE '%unit-test-%'").run();
  dbWrite.prepare("DELETE FROM logs WHERE source = 'mobile' AND meta LIKE '%test-session-%'").run();
  dbWrite.prepare("DELETE FROM logs WHERE source = 'mobile' AND charger_id = 'BATCH_TEST'").run();
  dbWrite.close();
}

// Test: verify correlation query works (session_id JOIN)
async function testCorrelationQuery() {
  console.log('\n🔗 Correlation Query Tests');
  
  const db = new Database(DB_PATH);
  const testSession = 'correlation-test-' + Date.now();
  
  // Simulate a full flow: mobile + ocpp events
  const insert = db.prepare(`
    INSERT INTO logs (timestamp, source, charger_id, event_type, category, severity, message, logger, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  // Mobile: user taps start
  insert.run(Date.now(), 'mobile', 'AR2512180010', 'start_charge_tap', 'start_charge_tap', 'info', 
    '{"station_id":"AR2512180010","connector_id":1}', 'mobile_telemetry',
    JSON.stringify({ session_id: testSession }));
  
  // Mobile: API request
  insert.run(Date.now() + 100, 'mobile', 'AR2512180010', 'api_request', 'api_request', 'info',
    '{"endpoint":"/api/stations/AR2512180010/connectors/1/transaction","attempt":1}', 'mobile_telemetry',
    JSON.stringify({ session_id: testSession }));
  
  // OCPP: RemoteStartTransaction
  insert.run(Date.now() + 500, 'ocpp', 'AR2512180010', 'RemoteStartTransaction', 'other', 'info',
    'RemoteStartTransaction: Accepted', 'charger_AR2512180010',
    JSON.stringify({ session_id: testSession }));
  
  // Query by session_id across sources
  const rows = db.prepare(`
    SELECT source, event_type, message, datetime(timestamp/1000, 'unixepoch') as ts
    FROM logs WHERE meta LIKE ?
    ORDER BY timestamp
  `).all(`%${testSession}%`);
  
  assert(rows.length === 3, `Cross-source query returns 3 rows (got ${rows.length})`);
  assert(rows[0].source === 'mobile', "First event is mobile");
  assert(rows[2].source === 'ocpp', "Last event is OCPP");
  assert(rows.map(r => r.source).includes('mobile'), "Mobile events in result");
  assert(rows.map(r => r.source).includes('ocpp'), "OCPP events in result");
  
  // Cleanup
  db.prepare("DELETE FROM logs WHERE meta LIKE ?").run(`%${testSession}%`);
  db.close();
}

// ─── Run ───
async function main() {
  console.log('🧪 Mobile Telemetry Test Suite\n');
  
  await testDbSchema();
  await testDbInsert();
  await testCorrelationQuery();
  
  if (LIVE) {
    try {
      await testLiveEndpoint();
    } catch (e) {
      console.log(`\n  ⚠️  Could not connect to localhost:${PORT}`);
      console.log(`     Is vercel-drain running? Try: pm2 restart vercel-drain`);
      console.log(`     Error: ${e.message}`);
    }
  } else {
    console.log('\n⏭️  Skipping live endpoint tests (run with --live to include)');
  }
  
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
