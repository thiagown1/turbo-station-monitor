#!/usr/bin/env node
/**
 * Vercel drain DB maintenance
 * - Creates daily aggregates before deletion
 * - Deletes vercel_logs/vercel_requests older than the retention window
 * - Vacuums database to reclaim space
 * - Logs cleanup statistics
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'db', 'vercel.db');
const RETENTION_DAYS = 14;
const MILLISECONDS_PER_DAY = 86400000;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function getDbSize() {
  return fs.statSync(dbPath).size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function runCleanup() {
  log('Starting vercel.db cleanup...');

  const db = new Database(dbPath);
  // Wait out brief write-lock contention with the vercel-drain writer instead
  // of failing. Repo standard (see services/mobile-telemetry/lib/db.js).
  db.pragma('busy_timeout = 5000');
  const sizeBefore = getDbSize();

  try {
    const cutoffTimestamp = Date.now() - (RETENTION_DAYS * MILLISECONDS_PER_DAY);
    const cutoffDate = new Date(cutoffTimestamp).toISOString();

    log(`Cutoff date: ${cutoffDate} (${RETENTION_DAYS} days ago)`);

    const toDelete = db.prepare(`SELECT COUNT(*) as count FROM vercel_logs WHERE timestamp < ?`).get(cutoffTimestamp).count;

    if (toDelete === 0) {
      log('No old vercel_logs rows to delete');
      db.close();
      return;
    }

    log(`vercel_logs rows to delete: ${toDelete}`);

    log('Creating daily aggregates...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS vercel_daily_aggregates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        endpoint TEXT,
        request_count INTEGER,
        error_count INTEGER,
        avg_duration_ms REAL,
        max_duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(date, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_vercel_agg_date ON vercel_daily_aggregates(date DESC);
    `);

    const aggregates = db.prepare(`
      INSERT OR REPLACE INTO vercel_daily_aggregates
        (date, endpoint, request_count, error_count, avg_duration_ms, max_duration_ms, created_at)
      SELECT
        DATE(timestamp / 1000, 'unixepoch') as date,
        endpoint,
        COUNT(*) as request_count,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count,
        AVG(duration_ms) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        ? as created_at
      FROM vercel_logs
      WHERE timestamp < ?
      GROUP BY date, endpoint
    `).run(Date.now(), cutoffTimestamp);

    log(`Aggregates: ${aggregates.changes} rows created/updated`);

    log('Deleting old rows (chunked, lock-friendly)...');

    // Delete in bounded chunks, each an implicit (auto-committed) transaction,
    // so the exclusive write lock is RELEASED between chunks. That lets the
    // separate vercel-drain process interleave its inserts (it waits out a
    // single chunk via busy_timeout=5000 rather than dropping the batch).
    // A single unbounded DELETE previously held the lock ~45s+; the VACUUM
    // below it held the lock ~18min — that combined window was the nightly
    // ingest-stall the monitor kept alerting on. NOTE: better-sqlite3's bundled
    // SQLite lacks DELETE..LIMIT, so we bound via a rowid subquery.
    const CHUNK_SIZE = 20000;

    const deleteChunked = (table, tsCol) => {
      const stmt = db.prepare(
        `DELETE FROM ${table} WHERE rowid IN ` +
        `(SELECT rowid FROM ${table} WHERE ${tsCol} < ? LIMIT ${CHUNK_SIZE})`
      );
      let total = 0;
      for (;;) {
        const r = stmt.run(cutoffTimestamp);
        total += r.changes;
        if (r.changes < CHUNK_SIZE) break;
      }
      return total;
    };

    log(`Deleted ${deleteChunked('vercel_logs', 'timestamp')} vercel_logs rows`);
    log(`Deleted ${deleteChunked('vercel_requests', 'last_ts')} vercel_requests rows`);

    // NO VACUUM. This DB is at steady state (daily deletes ≈ daily inserts), so
    // freed pages are immediately reused by the drain — 5+ nights of logs showed
    // VACUUM reclaimed 0 bytes (often NEGATIVE, e.g. -303104 B on 2026-07-06)
    // while holding an exclusive lock for ~18min, during which the drain dropped
    // EVERY batch (it returns 200 to Vercel regardless, so those logs were lost
    // for good). Removing VACUUM also stops the ~5GB WAL bloat: VACUUM rewrote
    // the entire 4.8GB db into the WAL each night, then its TRUNCATE checkpoint
    // reported busy:1 and never reclaimed it.
    //
    // A PASSIVE checkpoint is non-blocking (never takes the exclusive lock the
    // old TRUNCATE wanted) and keeps the WAL bounded during normal operation.
    log('Checkpointing WAL (passive)...');
    const chk = db.pragma('wal_checkpoint(PASSIVE)');
    log(`WAL checkpoint result: ${JSON.stringify(chk)}`);

    // Without VACUUM the main .db file does not shrink (freed pages are kept
    // for reuse) — this is expected and intentional, not a failure to reclaim.
    const sizeAfter = getDbSize();
    log(`DB file size (no VACUUM, pages reused): ${formatBytes(sizeBefore)} -> ${formatBytes(sizeAfter)}`);

    const remainingLogs = db.prepare('SELECT COUNT(*) as count FROM vercel_logs').get().count;
    const remainingReqs = db.prepare('SELECT COUNT(*) as count FROM vercel_requests').get().count;
    log(`Remaining: ${remainingLogs} vercel_logs, ${remainingReqs} vercel_requests rows`);

    log('Cleanup completed successfully!');
  } catch (error) {
    log(`Error during cleanup: ${error.message}`);
    throw error;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  runCleanup()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runCleanup };
