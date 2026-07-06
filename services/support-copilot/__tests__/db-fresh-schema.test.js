#!/usr/bin/env node
/**
 * Fresh-schema migration test — Support Copilot
 *
 * Regression test: `lib/db.js` prepared statements (findConvByAlias,
 * findConvByPhoneOrAlias, findDuplicateConv) reference conversations.phone_aliases,
 * but no safeAddColumn() migration ever added that column. Against a brand-new,
 * empty sqlite file (fresh dev machine, fresh CI runner, fresh worktree — no
 * pre-existing DB to have picked up the column from an earlier ad-hoc ALTER),
 * `require('../lib/db')` threw `SqliteError: no such column: phone_aliases` and
 * crashed anything that loads it, including `npm test` itself. Production was
 * unaffected only because its DB already had the column from before this
 * migration list existed.
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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
