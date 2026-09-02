#!/usr/bin/env node

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  CLEANUP_START_HOUR_UTC,
  CLEANUP_START_WINDOW_MINUTES,
  isWithinScheduledStartWindow,
  parseCliArgs,
  runCleanup,
} = require('../scripts/cleanup-vercel');

const WINDOW_START = new Date('2026-09-02T03:00:00.000Z');
const OUTSIDE_WINDOW = new Date('2026-09-02T04:00:00.000Z');

function makeDb(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-cleanup-safety-'));
  const file = path.join(dir, 'vercel.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE vercel_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      endpoint TEXT,
      status_code INTEGER,
      duration_ms INTEGER
    );
    CREATE TABLE vercel_requests (
      request_id TEXT PRIMARY KEY,
      last_ts INTEGER
    );
  `);

  const oldTimestamp = WINDOW_START.getTime() - (15 * 86400000);
  const freshTimestamp = WINDOW_START.getTime() - 86400000;
  db.prepare('INSERT INTO vercel_logs (timestamp, endpoint, status_code, duration_ms) VALUES (?, ?, ?, ?)')
    .run(oldTimestamp, '/old', 500, 900);
  db.prepare('INSERT INTO vercel_logs (timestamp, endpoint, status_code, duration_ms) VALUES (?, ?, ?, ?)')
    .run(freshTimestamp, '/fresh', 200, 100);
  db.prepare('INSERT INTO vercel_requests (request_id, last_ts) VALUES (?, ?)').run('old-request', oldTimestamp);
  db.prepare('INSERT INTO vercel_requests (request_id, last_ts) VALUES (?, ?)').run('fresh-request', freshTimestamp);
  if (!options.keepOpen) db.close();

  return { dir, file, db: options.keepOpen ? db : null };
}

function snapshotFile(file) {
  const data = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return {
    hash: crypto.createHash('sha256').update(data).digest('hex'),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function snapshotDirectory(dir) {
  return Object.fromEntries(
    fs.readdirSync(dir).sort().map((name) => [name, snapshotFile(path.join(dir, name))]),
  );
}

function silentLogger() {}

test('scheduled start window is inclusive at 03:00Z and exclusive at 03:15Z', () => {
  assert.equal(CLEANUP_START_HOUR_UTC, 3);
  assert.equal(CLEANUP_START_WINDOW_MINUTES, 15);
  assert.equal(isWithinScheduledStartWindow(new Date('2026-09-02T02:59:59.999Z')), false);
  assert.equal(isWithinScheduledStartWindow(new Date('2026-09-02T03:00:00.000Z')), true);
  assert.equal(isWithinScheduledStartWindow(new Date('2026-09-02T03:14:59.999Z')), true);
  assert.equal(isWithinScheduledStartWindow(new Date('2026-09-02T03:15:00.000Z')), false);
});

test('CLI accepts only the explicit dry-run and force controls', () => {
  assert.deepEqual(parseCliArgs([]), { dryRun: false, force: false });
  assert.deepEqual(parseCliArgs(['--dry-run']), { dryRun: true, force: false });
  assert.deepEqual(parseCliArgs(['--force', '--dry-run']), { dryRun: true, force: true });
  assert.throws(() => parseCliArgs(['--unknown']), /Unknown argument/);
});

test('PM2 keeps the canonical one-shot 03:00 schedule without a force argument', () => {
  const ecosystem = require('../ecosystem.config');
  const app = ecosystem.apps.find((candidate) => candidate.name === 'cleanup-vercel-db');

  assert.ok(app, 'cleanup-vercel-db must remain registered in the canonical ecosystem');
  assert.equal(app.cron_restart, '0 3 * * *');
  assert.equal(app.autorestart, false);
  assert.equal(app.args, undefined, 'the scheduled run must pass through the normal time guard');
});

test('an initial start outside the UTC window skips before opening or touching the database', async () => {
  let opened = false;
  const result = await runCleanup({
    now: OUTSIDE_WINDOW,
    dbFilePath: path.join(os.tmpdir(), 'must-not-be-opened.db'),
    openDatabase() {
      opened = true;
      throw new Error('database must not be opened');
    },
    logger: silentLogger,
  });

  assert.equal(opened, false);
  assert.deepEqual(result, { status: 'skipped', reason: 'outside-start-window' });
});

test('--dry-run never opens a WAL database and leaves sidecars, bytes, timestamps, schema and rows unchanged', async () => {
  const { dir, file, db: writer } = makeDb({ keepOpen: true });
  try {
    const before = snapshotDirectory(dir);
    assert.ok(before['vercel.db-wal'], 'fixture must contain a live WAL sidecar');
    assert.ok(before['vercel.db-shm'], 'fixture must contain a live shared-memory sidecar');
    let opened = false;

    const result = await runCleanup({
      now: WINDOW_START,
      dryRun: true,
      dbFilePath: file,
      openDatabase() {
        opened = true;
        throw new Error('dry-run must not open SQLite');
      },
      logger: silentLogger,
    });

    assert.equal(opened, false);
    assert.equal(result.status, 'dry-run');
    assert.equal(result.databaseOpened, false);
    assert.equal(result.retentionDays, 14);
    assert.equal(result.cutoffTimestamp, WINDOW_START.getTime() - (14 * 86400000));
    assert.equal(result.dbFilePath, file);
    assert.deepEqual(
      snapshotDirectory(dir),
      before,
      'dry-run must not create, rewrite, resize or retimestamp the database or its live sidecars',
    );

    assert.equal(writer.prepare('SELECT COUNT(*) AS count FROM vercel_logs').get().count, 2);
    assert.equal(writer.prepare('SELECT COUNT(*) AS count FROM vercel_requests').get().count, 2);
    assert.equal(
      writer.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'vercel_daily_aggregates'").get().count,
      0,
      'dry-run must not create the aggregate table',
    );
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run is plan-only even when the target bytes are not a valid SQLite database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-cleanup-readonly-api-'));
  const file = path.join(dir, 'vercel.db');
  fs.writeFileSync(file, 'must-never-be-parsed-by-sqlite');
  try {
    const result = await runCleanup({
      now: WINDOW_START,
      dryRun: true,
      dbFilePath: file,
      logger: silentLogger,
      openDatabase() {
        throw new Error('dry-run must not call the SQLite factory');
      },
    });

    assert.equal(result.status, 'dry-run');
    assert.equal(result.databaseOpened, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--force explicitly permits an out-of-window dry-run without enabling writes', async () => {
  const { dir, file } = makeDb();
  try {
    const result = await runCleanup({
      now: OUTSIDE_WINDOW,
      dryRun: true,
      force: true,
      dbFilePath: file,
      logger: silentLogger,
    });

    assert.equal(result.status, 'dry-run');
    assert.equal(result.databaseOpened, false);
    assert.equal(result.cutoffTimestamp, OUTSIDE_WINDOW.getTime() - (14 * 86400000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scheduled invocation still aggregates and prunes only expired rows', async () => {
  const { dir, file } = makeDb();
  try {
    const result = await runCleanup({
      now: WINDOW_START,
      dbFilePath: file,
      logger: silentLogger,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.deletedVercelLogs, 1);
    assert.equal(result.deletedVercelRequests, 1);

    const db = new Database(file, { readonly: true });
    assert.deepEqual(db.prepare('SELECT endpoint FROM vercel_logs ORDER BY endpoint').all(), [{ endpoint: '/fresh' }]);
    assert.deepEqual(db.prepare('SELECT request_id FROM vercel_requests ORDER BY request_id').all(), [{ request_id: 'fresh-request' }]);
    assert.deepEqual(
      db.prepare('SELECT endpoint, request_count, error_count FROM vercel_daily_aggregates').all(),
      [{ endpoint: '/old', request_count: 1, error_count: 1 }],
    );
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
