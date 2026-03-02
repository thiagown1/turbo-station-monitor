#!/usr/bin/env node
/**
 * Test suite for mobile telemetry database migration
 * 
 * Tests:
 * 1. Migration creates correct schema
 * 2. Source constraint accepts 'mobile'
 * 3. Source constraint rejects invalid values
 * 4. All existing data is preserved
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use a test database
const TEST_DB_PATH = path.join(__dirname, 'db', 'logs-test.db');
const TEST_DB_DIR = path.dirname(TEST_DB_PATH);

console.log('[test-migration] Starting migration tests...');

// Cleanup previous test db if exists
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
  console.log('[test-migration] Cleaned up previous test database');
}

// Ensure db directory exists
if (!fs.existsSync(TEST_DB_DIR)) {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
}

let db;
let exitCode = 0;

try {
  // Step 1: Create initial schema (old version without 'mobile')
  console.log('[test-migration] Creating initial schema...');
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  
  db.prepare(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('ocpp', 'vercel')),
      charger_id TEXT,
      event_type TEXT,
      endpoint TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      region TEXT,
      meta TEXT,
      level TEXT,
      request_id TEXT,
      body TEXT,
      severity TEXT,
      category TEXT,
      logger TEXT,
      message TEXT
    )
  `).run();
  
  // Insert test data
  console.log('[test-migration] Inserting test data...');
  const insertOcpp = db.prepare(`
    INSERT INTO logs (timestamp, source, charger_id, event_type, meta)
    VALUES (?, 'ocpp', 'AR123', 'StatusNotification', '{"status":"Available"}')
  `);
  const insertVercel = db.prepare(`
    INSERT INTO logs (timestamp, source, endpoint, status_code, duration_ms)
    VALUES (?, 'vercel', '/api/test', 200, 150)
  `);
  
  insertOcpp.run(Date.now());
  insertVercel.run(Date.now());
  
  const initialCount = db.prepare('SELECT COUNT(*) as count FROM logs').get().count;
  console.log(`[test-migration] Inserted ${initialCount} test records`);
  
  db.close();
  
  // Step 2: Run migration
  console.log('[test-migration] Running migration...');
  const { execSync } = require('child_process');
  
  // Temporarily modify the migration script to use test database
  const migrationScript = fs.readFileSync('./migrate-db-mobile.js', 'utf8');
  const testMigrationScript = migrationScript.replace(
    "path.join(__dirname, 'db', 'logs.db')",
    `'${TEST_DB_PATH}'`
  );
  
  fs.writeFileSync('./migrate-db-mobile-test.js', testMigrationScript);
  
  try {
    execSync('node migrate-db-mobile-test.js', { stdio: 'inherit' });
  } finally {
    fs.unlinkSync('./migrate-db-mobile-test.js');
  }
  
  // Step 3: Verify migration results
  console.log('[test-migration] Verifying migration results...');
  db = new Database(TEST_DB_PATH);
  
  // Test 1: Check schema has 'mobile' in constraint
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='logs'").get();
  if (!schema.sql.includes("'mobile'")) {
    console.error('[test-migration] ❌ FAIL: Schema does not include mobile in CHECK constraint');
    exitCode = 1;
  } else {
    console.log('[test-migration] ✓ Schema includes mobile in CHECK constraint');
  }
  
  // Test 2: Verify data was preserved
  const finalCount = db.prepare('SELECT COUNT(*) as count FROM logs').get().count;
  if (finalCount !== initialCount) {
    console.error(`[test-migration] ❌ FAIL: Data loss detected (before: ${initialCount}, after: ${finalCount})`);
    exitCode = 1;
  } else {
    console.log(`[test-migration] ✓ All ${finalCount} records preserved`);
  }
  
  // Test 3: Insert with source='mobile' should succeed
  try {
    db.prepare(`
      INSERT INTO logs (timestamp, source, event_type, meta)
      VALUES (?, 'mobile', 'screen_open', '{"session_id":"test"}')
    `).run(Date.now());
    console.log('[test-migration] ✓ Can insert records with source=mobile');
  } catch (err) {
    console.error('[test-migration] ❌ FAIL: Cannot insert mobile records:', err.message);
    exitCode = 1;
  }
  
  // Test 4: Insert with invalid source should fail
  try {
    db.prepare(`
      INSERT INTO logs (timestamp, source, event_type, meta)
      VALUES (?, 'invalid', 'test', '{}')
    `).run(Date.now());
    console.error('[test-migration] ❌ FAIL: CHECK constraint should reject invalid source');
    exitCode = 1;
  } catch (err) {
    if (err.message.includes('CHECK constraint failed')) {
      console.log('[test-migration] ✓ CHECK constraint correctly rejects invalid source');
    } else {
      console.error('[test-migration] ❌ FAIL: Wrong error type:', err.message);
      exitCode = 1;
    }
  }
  
  // Test 5: Verify OCPP and Vercel records still work
  try {
    db.prepare(`
      INSERT INTO logs (timestamp, source, charger_id, event_type)
      VALUES (?, 'ocpp', 'TEST', 'Heartbeat')
    `).run(Date.now());
    db.prepare(`
      INSERT INTO logs (timestamp, source, endpoint, status_code)
      VALUES (?, 'vercel', '/test', 200)
    `).run(Date.now());
    console.log('[test-migration] ✓ OCPP and Vercel records still work');
  } catch (err) {
    console.error('[test-migration] ❌ FAIL: Cannot insert OCPP/Vercel records:', err.message);
    exitCode = 1;
  }
  
  // Test 6: Verify mobile records are queryable
  const mobileCount = db.prepare("SELECT COUNT(*) as count FROM logs WHERE source='mobile'").get().count;
  if (mobileCount === 0) {
    console.error('[test-migration] ❌ FAIL: No mobile records found after insertion');
    exitCode = 1;
  } else {
    console.log(`[test-migration] ✓ Found ${mobileCount} mobile record(s)`);
  }
  
  db.close();
  
  // Cleanup
  console.log('[test-migration] Cleaning up test database...');
  fs.unlinkSync(TEST_DB_PATH);
  // Clean up WAL files if they exist
  if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
  if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
  
  if (exitCode === 0) {
    console.log('\n[test-migration] ✅ All migration tests passed!');
  } else {
    console.error('\n[test-migration] ❌ Some tests failed!');
  }
  
} catch (err) {
  console.error('[test-migration] ❌ Test suite failed:', err.message);
  if (db) db.close();
  exitCode = 1;
}

process.exit(exitCode);
