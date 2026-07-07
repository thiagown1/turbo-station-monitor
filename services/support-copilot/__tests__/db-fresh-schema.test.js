#!/usr/bin/env node
/**
 * Fresh-schema migration test — Support Copilot
 *
 * Regression test #1: `lib/db.js` prepared statements (findConvByAlias,
 * findConvByPhoneOrAlias, findDuplicateConv) reference conversations.phone_aliases,
 * but no safeAddColumn() migration ever added that column. Against a brand-new,
 * empty sqlite file (fresh dev machine, fresh CI runner, fresh worktree — no
 * pre-existing DB to have picked up the column from an earlier ad-hoc ALTER),
 * `require('../lib/db')` threw `SqliteError: no such column: phone_aliases` and
 * crashed anything that loads it, including `npm test` itself. Production was
 * unaffected only because its DB already had the column from before this
 * migration list existed.
 *
 * Regression test #2: same root cause, different column. `routes/conversations.js`
 * (PATCH /:id/tags) and `lib/copilot.js` (auto-tag persist from `[TAGS:...]`
 * suggestions) both run `UPDATE conversations SET tags = ...`, but no
 * safeAddColumn() migration ever added a `tags` column either. Against a fresh
 * DB this threw `SQLite Error: no such column: tags` on every suggestion
 * generation and every tag PATCH — silently, since both call sites wrap the
 * UPDATE in try/catch + console.warn. Production was unaffected only because
 * its DB already had the column from an earlier ad-hoc path.
 *
 * Regression test #3: same root cause, `messages.delivery_status`. Every
 * outbound-send call site (`routes/conversations.js`, `routes/ingest-evolution.js`)
 * INSERTs or UPDATEs `delivery_status`, but no safeAddColumn() migration ever
 * added that column either. Against a fresh DB this throws
 * `SqliteError: table messages has no column named delivery_status` on the
 * very first outbound message. Production was unaffected only because its DB
 * already had the column from an earlier ad-hoc path. Flagged by Codex on
 * PR #19 (services/support-copilot/routes/test-runner.js, recovered from the
 * live VPS deployment, which also inserts delivery_status).
 *
 * Runs lib/db.js in a child process against a throwaway DB path so this test
 * doesn't share the singleton `db` connection with the other test files.
 *
 * Run: node services/support-copilot/__tests__/db-fresh-schema.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function freshDbPath(tag) {
  return path.join(os.tmpdir(), `support-copilot-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

console.log('\n🧪 lib/db.js — fresh/empty database schema\n');

test('require("../lib/db") does not throw against a brand-new, empty sqlite file', () => {
  const dbPath = freshDbPath('loads');
  assert.equal(fs.existsSync(dbPath), false, 'precondition: db file must not pre-exist');

  try {
    const output = execFileSync(
      process.execPath,
      ['-e', "require('./lib/db.js'); console.log('loaded-ok');"],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath },
        encoding: 'utf8',
      }
    );
    assert.ok(output.includes('loaded-ok'), 'module should finish loading and log the marker');
  } finally {
    cleanup(dbPath);
  }
});

test('conversations.phone_aliases column exists after a fresh load', () => {
  const dbPath = freshDbPath('cols');

  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
        require('./lib/db.js');
        const Database = require('better-sqlite3');
        const check = new Database(process.env.SUPPORT_COPILOT_DB_PATH, { readonly: true });
        const cols = check.prepare("PRAGMA table_info('conversations')").all().map(r => r.name);
        if (!cols.includes('phone_aliases')) {
          throw new Error('phone_aliases column missing after fresh load: ' + cols.join(','));
        }
        `,
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath },
        encoding: 'utf8',
      }
    );
  } finally {
    cleanup(dbPath);
  }
});

test('conversations.tags column exists after a fresh load', () => {
  const dbPath = freshDbPath('tags-cols');

  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
        require('./lib/db.js');
        const Database = require('better-sqlite3');
        const check = new Database(process.env.SUPPORT_COPILOT_DB_PATH, { readonly: true });
        const cols = check.prepare("PRAGMA table_info('conversations')").all().map(r => r.name);
        if (!cols.includes('tags')) {
          throw new Error('tags column missing after fresh load: ' + cols.join(','));
        }
        `,
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath },
        encoding: 'utf8',
      }
    );
  } finally {
    cleanup(dbPath);
  }
});

test('UPDATE conversations SET tags = ... does not throw against a fresh load', () => {
  const dbPath = freshDbPath('tags-update');

  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
        const { db, randomId, nowIso } = require('./lib/db.js');
        const id = randomId('conv');
        const now = nowIso();
        db.prepare(
          \`INSERT INTO conversations (id, brand_id, channel, status, created_at, updated_at)
           VALUES (?, ?, 'whatsapp', 'open', ?, ?)\`
        ).run(id, 'test-brand', now, now);
        // Mirrors the UPDATE in routes/conversations.js (PATCH /:id/tags)
        // and lib/copilot.js (auto-tag persist) — must not throw.
        db.prepare('UPDATE conversations SET tags = ?, updated_at = ? WHERE id = ?')
          .run('vip,recharge', nowIso(), id);
        const row = db.prepare('SELECT tags FROM conversations WHERE id = ?').get(id);
        if (row.tags !== 'vip,recharge') {
          throw new Error('tags UPDATE did not persist: ' + JSON.stringify(row));
        }
        `,
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath },
        encoding: 'utf8',
      }
    );
  } finally {
    cleanup(dbPath);
  }
});

test('messages.delivery_status column exists after a fresh load', () => {
  const dbPath = freshDbPath('delivery-status-cols');

  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
        require('./lib/db.js');
        const Database = require('better-sqlite3');
        const check = new Database(process.env.SUPPORT_COPILOT_DB_PATH, { readonly: true });
        const cols = check.prepare("PRAGMA table_info('messages')").all().map(r => r.name);
        if (!cols.includes('delivery_status')) {
          throw new Error('delivery_status column missing after fresh load: ' + cols.join(','));
        }
        `,
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath },
        encoding: 'utf8',
      }
    );
  } finally {
    cleanup(dbPath);
  }
});

test('INSERT/UPDATE messages.delivery_status does not throw against a fresh load', () => {
  const dbPath = freshDbPath('delivery-status-update');

  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
        const { db, randomId, nowIso } = require('./lib/db.js');
        const convId = randomId('conv');
        const msgId = randomId('msg');
        const now = nowIso();
        db.prepare(
          \`INSERT INTO conversations (id, brand_id, channel, status, created_at, updated_at)
           VALUES (?, ?, 'whatsapp', 'open', ?, ?)\`
        ).run(convId, 'test-brand', now, now);
        // Mirrors the INSERT in routes/ingest-evolution.js / routes/conversations.js
        // (outbound send) — must not throw.
        db.prepare(
          \`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, delivery_status, created_at)
           VALUES (?, ?, ?, 'outbound', 'whatsapp', ?, 'pending', ?)\`
        ).run(msgId, convId, 'test-brand', 'oi', now);
        // Mirrors the UPDATE after the send resolves.
        db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run('sent', msgId);
        const row = db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(msgId);
        if (row.delivery_status !== 'sent') {
          throw new Error('delivery_status UPDATE did not persist: ' + JSON.stringify(row));
        }
        `,
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath },
        encoding: 'utf8',
      }
    );
  } finally {
    cleanup(dbPath);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
