#!/usr/bin/env node
/**
 * Database Migration: Add 'mobile' source to logs table
 * 
 * SQLite doesn't support ALTER CHECK, so we need to:
 * 1. Create a new table with the updated CHECK constraint
 * 2. Copy all data from old table
 * 3. Drop old table
 * 4. Rename new table to original name
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db', 'logs.db');

console.log('[migrate-db-mobile] Starting migration...');
console.log(`[migrate-db-mobile] Database: ${DB_PATH}`);

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  
  // Check current schema
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='logs'").get();
  console.log('[migrate-db-mobile] Current schema:');
  console.log(schema.sql);
  
  // Check if migration is needed
  if (schema.sql.includes("'mobile'")) {
    console.log('[migrate-db-mobile] ✓ Migration already applied - mobile source already exists');
    db.close();
    process.exit(0);
  }
  
  console.log('[migrate-db-mobile] Migration needed - adding mobile source...');
  
  // Begin transaction
  db.prepare('BEGIN').run();
  
  try {
    // Step 1: Create new table with updated CHECK constraint (ocpp, vercel, mobile)
    console.log('[migrate-db-mobile] Step 1: Creating new table with mobile source...');
    db.prepare(`
      CREATE TABLE logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('ocpp', 'vercel', 'mobile')),
        
        -- OCPP fields
        charger_id TEXT,
        event_type TEXT,
        
        -- Vercel fields
        endpoint TEXT,
        status_code INTEGER,
        duration_ms INTEGER,
        region TEXT,
        
        -- Vercel extra fields
        level TEXT,
        request_id TEXT,
        body TEXT,
        
        -- Mobile telemetry fields (will use meta for event data)
        
        -- OCPP extra fields
        severity TEXT,
        category TEXT,
        logger TEXT,
        message TEXT,
        
        -- Flexible metadata (JSON)
        meta TEXT
      )
    `).run();
    
    // Step 2: Copy all data from old table to new table
    console.log('[migrate-db-mobile] Step 2: Copying data...');
    const result = db.prepare(`
      INSERT INTO logs_new 
      SELECT * FROM logs
    `).run();
    console.log(`[migrate-db-mobile] Copied ${result.changes} rows`);
    
    // Step 3: Drop old table
    console.log('[migrate-db-mobile] Step 3: Dropping old table...');
    db.prepare('DROP TABLE logs').run();
    
    // Step 4: Rename new table to original name
    console.log('[migrate-db-mobile] Step 4: Renaming new table...');
    db.prepare('ALTER TABLE logs_new RENAME TO logs').run();
    
    // Commit transaction
    db.prepare('COMMIT').run();
    
    console.log('[migrate-db-mobile] ✓ Migration completed successfully!');
    console.log('[migrate-db-mobile] Mobile telemetry events can now be logged');
    
    // Verify the new schema
    const newSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='logs'").get();
    console.log('[migrate-db-mobile] New schema:');
    console.log(newSchema.sql);
    
  } catch (err) {
    // Rollback on error
    db.prepare('ROLLBACK').run();
    throw err;
  }
  
  db.close();
  
} catch (err) {
  console.error('[migrate-db-mobile] Migration failed:', err.message);
  if (db) db.close();
  process.exit(1);
}
