#!/usr/bin/env node
/**
 * Vercel drain DB maintenance
 * - Creates daily aggregates before deletion
 * - Deletes vercel_logs/vercel_requests older than the retention window
 * - Uses bounded deletes and a passive WAL checkpoint (never VACUUM)
 * - Refuses an accidental PM2 initial start outside the 03:00Z window
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'db', 'vercel.db');
const RETENTION_DAYS = 14;
const MILLISECONDS_PER_DAY = 86400000;
const CLEANUP_START_HOUR_UTC = 3;
const CLEANUP_START_WINDOW_MINUTES = 15;
const CHUNK_SIZE = 20000;
const CLEANUP_ENABLED_ENV = 'CLEANUP_VERCEL_ENABLED';

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function getDbSize(dbFilePath) {
  return fs.statSync(dbFilePath).size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('now must be a valid Date-compatible value');
  }
  return date;
}

/**
 * PM2 cron_restart schedules the process at 03:00 UTC. A short grace window
 * permits ordinary scheduler/process-start jitter while preventing `pm2 start
 * ecosystem.config.js` from immediately running destructive maintenance at an
 * arbitrary time of day.
 */
function isWithinScheduledStartWindow(now) {
  const instant = asDate(now);
  const start = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate(),
    CLEANUP_START_HOUR_UTC,
    0,
    0,
    0,
  );
  const end = start + (CLEANUP_START_WINDOW_MINUTES * 60 * 1000);
  return instant.getTime() >= start && instant.getTime() < end;
}

function parseCliArgs(argv) {
  const options = { dryRun: false, force: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function isLiveCleanupEnabled(env = process.env) {
  return env?.[CLEANUP_ENABLED_ENV] === '1';
}

function openSqlite(dbFilePath) {
  return new Database(dbFilePath);
}

function readCleanupPlan(db, cutoffTimestamp) {
  return {
    vercelLogsToDelete: db
      .prepare('SELECT COUNT(*) AS count FROM vercel_logs WHERE timestamp < ?')
      .get(cutoffTimestamp).count,
    vercelRequestsToDelete: db
      .prepare('SELECT COUNT(*) AS count FROM vercel_requests WHERE last_ts < ?')
      .get(cutoffTimestamp).count,
  };
}

async function runCleanup(options = {}) {
  const startedAt = asDate(options.now ?? new Date());
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const dbFilePath = options.dbFilePath || DEFAULT_DB_PATH;
  const openDatabase = options.openDatabase || openSqlite;
  const logger = options.logger || log;
  const env = options.env === undefined ? process.env : options.env;

  // Live retention is destructive and remains fail-closed independently of
  // the scheduler window and --force. Dry-run is deliberately exempt because
  // its contract below is no-open and zero-write.
  if (!dryRun && !isLiveCleanupEnabled(env)) {
    logger(
      `Skipped (disabled): live cleanup requires ${CLEANUP_ENABLED_ENV}=1; ` +
      '--force does not bypass this gate',
    );
    return { status: 'skipped', reason: 'disabled' };
  }

  // This remains before any database inspection. Outside the cron window we
  // do not stat or open SQLite, so an initial PM2 registration is inert.
  if (!force && !isWithinScheduledStartWindow(startedAt)) {
    logger(
      `Skipped (outside-start-window): ${startedAt.toISOString()} is outside the ` +
      `03:00-03:${String(CLEANUP_START_WINDOW_MINUTES).padStart(2, '0')} UTC start window ` +
      '(use --force for an explicitly authorized out-of-window run)',
    );
    return { status: 'skipped', reason: 'outside-start-window' };
  }

  logger(`Starting vercel.db cleanup${dryRun ? ' dry-run' : ''}...`);
  logger(`Database path: ${dbFilePath}`);

  const cutoffTimestamp = startedAt.getTime() - (RETENTION_DAYS * MILLISECONDS_PER_DAY);
  const cutoffDate = new Date(cutoffTimestamp).toISOString();
  logger(`Cutoff date: ${cutoffDate} (${RETENTION_DAYS} days ago)`);

  // Even SQLITE_OPEN_READONLY can create or update -wal/-shm sidecars. A true
  // zero-write dry-run therefore does not open SQLite at all; it reports the
  // deterministic policy/cutoff only. Candidate counts belong to a separately
  // controlled snapshot/diagnostic, never this safety path.
  if (dryRun) {
    logger(
      'Dry-run plan only: would count expired rows, aggregate expired vercel_logs, ' +
      'delete in bounded chunks, and run a passive checkpoint; database not opened',
    );
    return {
      status: 'dry-run',
      cutoffTimestamp,
      retentionDays: RETENTION_DAYS,
      databaseOpened: false,
      dbFilePath,
    };
  }

  const db = openDatabase(dbFilePath);

  try {
    // Wait out brief write-lock contention with the vercel-drain writer
    // instead of failing. This is never issued by the no-open dry-run.
    db.pragma('busy_timeout = 5000');
    const sizeBefore = getDbSize(dbFilePath);

    const plan = readCleanupPlan(db, cutoffTimestamp);
    logger(`vercel_logs rows to delete: ${plan.vercelLogsToDelete}`);
    logger(`vercel_requests rows to delete: ${plan.vercelRequestsToDelete}`);

    if (plan.vercelLogsToDelete === 0 && plan.vercelRequestsToDelete === 0) {
      logger('No expired Vercel rows to delete');
      return {
        status: 'completed',
        deletedVercelLogs: 0,
        deletedVercelRequests: 0,
      };
    }

    if (plan.vercelLogsToDelete > 0) {
      logger('Creating daily aggregates...');
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
          DATE(timestamp / 1000, 'unixepoch') AS date,
          endpoint,
          COUNT(*) AS request_count,
          SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
          AVG(duration_ms) AS avg_duration_ms,
          MAX(duration_ms) AS max_duration_ms,
          ? AS created_at
        FROM vercel_logs
        WHERE timestamp < ?
        GROUP BY date, endpoint
      `).run(startedAt.getTime(), cutoffTimestamp);
      logger(`Aggregates: ${aggregates.changes} rows created/updated`);
    }

    logger('Deleting old rows (chunked, lock-friendly)...');

    // Each chunk is an implicit auto-committed transaction, so the write lock
    // is released between chunks and vercel-drain can interleave inserts.
    const deleteChunked = (table, tsCol) => {
      const stmt = db.prepare(
        `DELETE FROM ${table} WHERE rowid IN ` +
        `(SELECT rowid FROM ${table} WHERE ${tsCol} < ? LIMIT ${CHUNK_SIZE})`,
      );
      let total = 0;
      for (;;) {
        const result = stmt.run(cutoffTimestamp);
        total += result.changes;
        if (result.changes < CHUNK_SIZE) break;
      }
      return total;
    };

    const deletedVercelLogs = deleteChunked('vercel_logs', 'timestamp');
    const deletedVercelRequests = deleteChunked('vercel_requests', 'last_ts');
    logger(`Deleted ${deletedVercelLogs} vercel_logs rows`);
    logger(`Deleted ${deletedVercelRequests} vercel_requests rows`);

    // NO VACUUM. Freed pages are reused by the drain. The former full VACUUM
    // held an exclusive lock for about 18 minutes and inflated the WAL. A
    // PASSIVE checkpoint is non-blocking and is live-run-only.
    logger('Checkpointing WAL (passive)...');
    const checkpoint = db.pragma('wal_checkpoint(PASSIVE)');
    logger(`WAL checkpoint result: ${JSON.stringify(checkpoint)}`);

    const sizeAfter = getDbSize(dbFilePath);
    logger(`DB file size (no VACUUM, pages reused): ${formatBytes(sizeBefore)} -> ${formatBytes(sizeAfter)}`);

    const remainingLogs = db.prepare('SELECT COUNT(*) AS count FROM vercel_logs').get().count;
    const remainingReqs = db.prepare('SELECT COUNT(*) AS count FROM vercel_requests').get().count;
    logger(`Remaining: ${remainingLogs} vercel_logs, ${remainingReqs} vercel_requests rows`);
    logger('Cleanup completed successfully!');

    return { status: 'completed', deletedVercelLogs, deletedVercelRequests };
  } catch (error) {
    logger(`Error during cleanup: ${error.message}`);
    throw error;
  } finally {
    db.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  return runCleanup(options);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  CLEANUP_ENABLED_ENV,
  CLEANUP_START_HOUR_UTC,
  CLEANUP_START_WINDOW_MINUTES,
  isLiveCleanupEnabled,
  isWithinScheduledStartWindow,
  parseCliArgs,
  readCleanupPlan,
  runCleanup,
};
