#!/usr/bin/env node
/**
 * Database Maintenance Script
 * - Creates daily aggregates before deletion
 * - Deletes logs older than 30 days
 * - Vacuums database to reclaim space
 * - Logs cleanup statistics
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'db', 'logs.db');
const RETENTION_DAYS = 30;
const MILLISECONDS_PER_DAY = 86400000;

// Logging function
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function getDbSize() {
  const stats = fs.statSync(dbPath);
  return stats.size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function runCleanup() {
  log('🧹 Starting database cleanup...');
  
  const db = new Database(dbPath);
  const sizeBefore = getDbSize();
  
  try {
    // Calculate cutoff timestamp
    const cutoffTimestamp = Date.now() - (RETENTION_DAYS * MILLISECONDS_PER_DAY);
    const cutoffDate = new Date(cutoffTimestamp).toISOString();
    
    log(`📅 Cutoff date: ${cutoffDate} (${RETENTION_DAYS} days ago)`);
    
    // Count logs to be deleted
    const logsToDelete = db.prepare(`
      SELECT 
        source,
        COUNT(*) as count
      FROM logs
      WHERE timestamp < ?
      GROUP BY source
    `).all(cutoffTimestamp);
    
    const totalToDelete = logsToDelete.reduce((sum, row) => sum + row.count, 0);
    
    if (totalToDelete === 0) {
      log('✅ No old logs to delete');
      db.close();
      return;
    }
    
    log(`📊 Logs to delete: ${totalToDelete} total`);
    logsToDelete.forEach(row => {
      log(`   - ${row.source}: ${row.count} rows`);
    });
    
    // === STEP 1: Create Daily Aggregates ===
    log('📈 Creating daily aggregates...');
    
    // Create aggregates table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_aggregates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        
        -- OCPP aggregates
        charger_id TEXT,
        event_type TEXT,
        event_count INTEGER,
        
        -- Vercel aggregates
        endpoint TEXT,
        request_count INTEGER,
        error_count INTEGER,
        avg_duration_ms REAL,
        max_duration_ms INTEGER,
        
        created_at INTEGER NOT NULL,
        UNIQUE(date, source, charger_id, event_type, endpoint)
      );
      
      CREATE INDEX IF NOT EXISTS idx_agg_date ON daily_aggregates(date DESC);
      CREATE INDEX IF NOT EXISTS idx_agg_source ON daily_aggregates(source);
    `);
    
    // Aggregate OCPP events by charger/day
    const ocppAggregates = db.prepare(`
      INSERT OR REPLACE INTO daily_aggregates 
        (date, source, charger_id, event_type, event_count, created_at)
      SELECT 
        DATE(timestamp / 1000, 'unixepoch') as date,
        'ocpp' as source,
        charger_id,
        event_type,
        COUNT(*) as event_count,
        ? as created_at
      FROM logs
      WHERE source = 'ocpp' 
        AND timestamp < ?
        AND charger_id IS NOT NULL
      GROUP BY date, charger_id, event_type
    `).run(Date.now(), cutoffTimestamp);
    
    log(`   ✅ OCPP aggregates: ${ocppAggregates.changes} rows created`);
    
    // Aggregate Vercel logs by endpoint/day
    const vercelAggregates = db.prepare(`
      INSERT OR REPLACE INTO daily_aggregates 
        (date, source, endpoint, request_count, error_count, avg_duration_ms, max_duration_ms, created_at)
      SELECT 
        DATE(timestamp / 1000, 'unixepoch') as date,
        'vercel' as source,
        endpoint,
        COUNT(*) as request_count,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count,
        AVG(duration_ms) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        ? as created_at
      FROM logs
      WHERE source = 'vercel' 
        AND timestamp < ?
        AND endpoint IS NOT NULL
      GROUP BY date, endpoint
    `).run(Date.now(), cutoffTimestamp);
    
    log(`   ✅ Vercel aggregates: ${vercelAggregates.changes} rows created`);
    
    // === STEP 2: Delete Old Logs (Transactional) ===
    log('🗑️  Deleting old logs (transactional)...');
    
    db.transaction(() => {
      const deleteResult = db.prepare(`
        DELETE FROM logs
        WHERE timestamp < ?
      `).run(cutoffTimestamp);
      
      log(`   ✅ Deleted ${deleteResult.changes} rows`);
    })();
    
    // === STEP 3: Vacuum Database ===
    log('🔧 Vacuuming database to reclaim space...');
    db.exec('VACUUM');
    
    const sizeAfter = getDbSize();
    const spaceFreed = sizeBefore - sizeAfter;
    
    log(`💾 Space freed: ${formatBytes(spaceFreed)}`);
    log(`📊 Database size: ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)}`);
    
    // === STEP 4: Log Stats ===
    const totalLogs = db.prepare('SELECT COUNT(*) as count FROM logs').get().count;
    const totalAggregates = db.prepare('SELECT COUNT(*) as count FROM daily_aggregates').get().count;
    
    log(`📈 Remaining logs: ${totalLogs}`);
    log(`📊 Total aggregates: ${totalAggregates}`);
    
    log('✅ Cleanup completed successfully!');
    
  } catch (error) {
    log(`❌ Error during cleanup: ${error.message}`);
    throw error;
  } finally {
    db.close();
  }
}

// Run if executed directly
if (require.main === module) {
  runCleanup()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runCleanup };
