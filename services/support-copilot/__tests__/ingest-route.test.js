#!/usr/bin/env node
/**
 * WhatsApp Ingest Route Tests — Support Copilot
 *
 * Regression test: `routes/ingest.js` looked up the existing conversation with
 * `stmts.findConvByPhone.get(brand_id, normalizedPhone)`, but `findConvByPhone`
 * (lib/db.js) is defined with a single placeholder
 * (`customer_phone = ?`) and is intentionally BRAND-AGNOSTIC — a phone number
 * uniquely identifies a customer regardless of brand_id (see auto-merge.test.js).
 * better-sqlite3 throws `RangeError: too many parameter values were provided`
 * when a bound statement gets more arguments than placeholders, so every
 * single POST to this endpoint crashed the request handler. Flagged by Codex
 * on PR #19 (this route was recovered verbatim from the live VPS deployment,
 * where it turned out to be unreachable dead code — its real-traffic
 * equivalent is `routes/ingest-evolution.js`, which never had this bug).
 *
 * Runs the route in a child process against a throwaway DB path so this test
 * doesn't share the singleton `db` connection with the other test files.
 *
 * Run: node services/support-copilot/__tests__/ingest-route.test.js
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

console.log('\n🧪 routes/ingest.js — POST /api/support/ingest/whatsapp\n');

test('POST does not throw on the phone lookup and upserts the same conversation on repeat', () => {
  const dbPath = freshDbPath('ingest-route');

  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
        const express = require('express');
        const supertest = require('supertest');

        const app = express();
        app.use(express.json());
        app.use('/', require('./routes/ingest.js'));

        (async () => {
          const payload = { brand_id: 'test-brand', phone: '5561999998888', customer_name: 'Test User', body: 'oi' };

          const first = await supertest(app).post('/').send(payload);
          if (first.status !== 201) {
            throw new Error('first POST expected 201, got ' + first.status + ': ' + JSON.stringify(first.body));
          }
          if (!first.body.created) {
            throw new Error('first POST expected created=true: ' + JSON.stringify(first.body));
          }

          const second = await supertest(app).post('/').send({ ...payload, body: 'tudo bem?' });
          if (second.status !== 201) {
            throw new Error('second POST expected 201, got ' + second.status + ': ' + JSON.stringify(second.body));
          }
          if (second.body.created) {
            throw new Error('second POST should upsert the existing conversation, not create a new one: ' + JSON.stringify(second.body));
          }
          if (second.body.conversationId !== first.body.conversationId) {
            throw new Error('second POST returned a different conversationId than the first: ' + JSON.stringify({ first: first.body, second: second.body }));
          }
        })().catch(err => { console.error(err.stack || err.message); process.exit(1); });
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
