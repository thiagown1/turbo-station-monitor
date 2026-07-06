#!/usr/bin/env node
/**
 * Regression test for the 2026-07-06 "Ingest vercel parado/sem dados" incident.
 *
 * Root cause: the nightly cleanup-vercel cron ran a full VACUUM on vercel.db,
 * holding SQLite's exclusive write lock for ~18 minutes. During that window the
 * vercel-drain writer had NO busy_timeout, so every INSERT threw SQLITE_BUSY
 * immediately; insertLogs swallowed the error and the handler returned 200 to
 * Vercel anyway, so the drain never retried and those prod logs were lost.
 *
 * The fix has two halves, both exercised here at the SQLite layer (no network,
 * no real db) with a real cross-process lock holder:
 *   1. Every connection gets `busy_timeout = 5000` (repo standard, lib/db.js) so
 *      a writer WAITS OUT brief contention instead of dropping the batch.
 *   2. cleanup deletes in bounded chunks and no longer VACUUMs, so the lock is
 *      released frequently and the 5000ms wait is always enough.
 *
 * Run: node --test test/test-vercel-cleanup-locking.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const HOLD_MS = 1500; // how long the child keeps the write lock after signalling

// Child process: grabs the write lock, tells us, holds it, then releases.
// Simulates cleanup-vercel holding the lock while it deletes/vacuums.
const CHILD_SRC = `
  const Database = require('better-sqlite3');
  const db = new Database(process.argv[1]);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO vercel_logs (timestamp, body) VALUES (?, ?)').run(Date.now(), 'child-holds-lock');
  process.stdout.write('LOCKED\\n');
  setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, ${HOLD_MS});
`;

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdrain-lock-'));
  const file = path.join(dir, 'vercel.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE vercel_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, body TEXT)');
  db.close();
  return { dir, file };
}

function spawnLockHolder(file) {
  const child = spawn(process.execPath, ['-e', CHILD_SRC, file], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const locked = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); if (out.includes('LOCKED')) resolve(); });
    child.on('exit', (code) => {
      if (!out.includes('LOCKED')) reject(new Error(`child exited (code ${code}) before LOCKED. stderr: ${stderr}`));
    });
    child.on('error', reject);
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { child, locked, exited };
}

test('a connection reports a non-zero busy_timeout after the repo-standard pragma', () => {
  const { dir, file } = makeDb();
  try {
    const db = new Database(file);
    db.pragma('busy_timeout = 5000');
    const [{ timeout }] = db.pragma('busy_timeout');
    assert.strictEqual(timeout, 5000, `expected busy_timeout 5000, got ${timeout}`);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WITHOUT busy_timeout, a concurrent writer throws SQLITE_BUSY (the pre-fix drop path)', async () => {
  const { dir, file } = makeDb();
  const { locked, exited } = spawnLockHolder(file);
  try {
    await locked; // child now holds the write lock for HOLD_MS
    const db = new Database(file);
    db.pragma('busy_timeout = 0'); // explicitly no waiting = old drain behavior
    const insert = () => db.prepare('INSERT INTO vercel_logs (timestamp, body) VALUES (?, ?)').run(Date.now(), 'drain-row');
    assert.throws(insert, /SQLITE_BUSY|database is locked/i,
      'a zero-timeout writer must fail fast while the lock is held — this is the batch that used to be dropped');
    db.close();
  } finally {
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WITH busy_timeout=5000, a concurrent writer waits out the lock and commits (the fix)', async () => {
  const { dir, file } = makeDb();
  const { locked, exited } = spawnLockHolder(file);
  try {
    await locked; // child holds the lock for HOLD_MS; our write must survive it
    const db = new Database(file);
    db.pragma('busy_timeout = 5000');
    // This INSERT blocks synchronously until the child COMMITs (~HOLD_MS), then succeeds.
    const info = db.prepare('INSERT INTO vercel_logs (timestamp, body) VALUES (?, ?)').run(Date.now(), 'drain-row');
    assert.ok(info.changes === 1, 'the drain write must eventually commit, not drop');
    const rows = db.prepare("SELECT COUNT(*) AS c FROM vercel_logs WHERE body = 'drain-row'").get().c;
    assert.strictEqual(rows, 1, 'the drain row must be persisted');
    db.close();
  } finally {
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
