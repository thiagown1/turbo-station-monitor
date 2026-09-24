#!/usr/bin/env node
/**
 * Regression test for the 2026-09-10 "disco a 97%, CI parada" incident.
 *
 * Root cause: vercel.db is the drain's log store and its retention window was
 * 14 days. At roughly 850 MB of prod logs a day that is a 12 GB steady state on
 * a 197 GB box that also hosts the CI runners, the agent workspaces and 28 GB of
 * routing tiles. When free space ran out the Firebase emulator could no longer
 * boot, so Integration Tests and Web E2E failed on every PR with an error that
 * named neither the disk nor the emulator ("An unexpected error has occurred",
 * then curl exit 7 because the Next server never came up).
 *
 * The window is now 7 days. That number is the only thing standing between the
 * box and the same outage, so it is asserted here rather than left as a constant
 * nobody reads:
 *   1. rows older than the window are deleted, rows inside it are kept;
 *   2. per-endpoint daily aggregates are written BEFORE the delete, so
 *      shortening the window costs raw request bodies, never traffic history;
 *   3. the window is overridable, which is how a one-off shrink is run.
 *
 * Run: node --test test/test-vercel-retention-window.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CLEANUP = path.join(REPO_ROOT, 'scripts', 'cleanup-vercel.js');
const DAY = 86400000;

/** A throwaway vercel.db carrying the columns the cleanup touches. */
function makeDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-retention-'));
  const file = path.join(dir, 'vercel.db');
  const db = new Database(file);
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
      last_ts INTEGER,
      endpoint TEXT
    );
  `);
  const log = db.prepare('INSERT INTO vercel_logs (timestamp, endpoint, status_code, duration_ms) VALUES (?,?,?,?)');
  const req = db.prepare('INSERT INTO vercel_requests (request_id, last_ts, endpoint) VALUES (?,?,?)');
  rows.forEach(({ ageDays, endpoint = '/api/x', status = 200 }, i) => {
    const ts = Date.now() - ageDays * DAY;
    log.run(ts, endpoint, status, 10);
    req.run(`req-${i}`, ts, endpoint);
  });
  db.close();
  return { dir, file };
}

function runCleanup(file, env = {}) {
  execFileSync(process.execPath, [CLEANUP], {
    cwd: REPO_ROOT,
    env: { ...process.env, VERCEL_DB_PATH: file, ...env },
    stdio: 'pipe',
  });
}

function read(file, sql) {
  const db = new Database(file, { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

test('keeps the last 7 days and drops what is older', () => {
  const { dir, file } = makeDb([
    { ageDays: 0 },
    { ageDays: 6 },
    { ageDays: 8 },
    { ageDays: 20 },
  ]);
  try {
    runCleanup(file);

    const ages = read(file, 'SELECT timestamp FROM vercel_logs')
      .map(r => Math.round((Date.now() - r.timestamp) / DAY))
      .sort((a, b) => a - b);
    assert.deepStrictEqual(ages, [0, 6], 'only rows inside the 7-day window survive');

    const reqs = read(file, 'SELECT request_id FROM vercel_requests');
    assert.strictEqual(reqs.length, 2, 'vercel_requests is pruned on the same window');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregates the deleted days before deleting them', () => {
  // The traffic history has to outlive the raw bodies, otherwise shortening the
  // window would silently erase what the dashboards read.
  const { dir, file } = makeDb([
    { ageDays: 10, endpoint: '/api/pay', status: 200 },
    { ageDays: 10, endpoint: '/api/pay', status: 500 },
    { ageDays: 1, endpoint: '/api/pay', status: 200 },
  ]);
  try {
    runCleanup(file);

    const agg = read(file, "SELECT endpoint, request_count, error_count FROM vercel_daily_aggregates WHERE endpoint = '/api/pay'");
    assert.strictEqual(agg.length, 1, 'one aggregate row for the deleted day');
    assert.strictEqual(agg[0].request_count, 2, 'both deleted rows are counted');
    assert.strictEqual(agg[0].error_count, 1, 'the 500 is counted as an error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the window is overridable, which is how a one-off shrink is run', () => {
  const { dir, file } = makeDb([
    { ageDays: 1 },
    { ageDays: 5 },
  ]);
  try {
    runCleanup(file, { VERCEL_RETENTION_DAYS: '3' });

    const ages = read(file, 'SELECT timestamp FROM vercel_logs')
      .map(r => Math.round((Date.now() - r.timestamp) / DAY));
    assert.deepStrictEqual(ages, [1], 'a 3-day override drops the 5-day-old row the default would keep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
