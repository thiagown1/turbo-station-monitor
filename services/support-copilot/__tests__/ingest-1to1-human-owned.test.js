#!/usr/bin/env node
/**
 * 1:1 auto-suggest / auto-respond timer vs. human ownership.
 *
 * The debounce timer in routes/ingest-evolution.js reads the conversation once,
 * then awaits the customer lookup, the model and a typing delay. A person who
 * takes over or escalates during those awaits must stop the reply. Regression
 * for the Codex finding on turbo-station-monitor#114.
 *
 * Each scenario runs the real route in a child process (own throwaway DB) with
 * the model, the Evolution client and the customer lookup replaced by stubs.
 * No network, no WhatsApp, no real model call.
 *
 * Run: node services/support-copilot/__tests__/ingest-1to1-human-owned.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ─── Child: one scenario against the real route ─────────────────────────────

async function runChild(scenario) {
  // Shrink the 5 s debounce and the humanized typing delay. Nothing else here
  // uses a timer of 1.5 s or more.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 1500 ? 5 : ms, ...args);

  const stub = (relative, exports) => {
    const file = require.resolve(relative);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  const calls = { generate: 0, presence: 0, send: 0 };
  let db;
  const setStatus = (status) => db.prepare("UPDATE conversations SET status = ? WHERE channel = 'whatsapp'").run(status);

  // The route reads only `auto_suggest, auto_respond` from copilot_settings, so
  // the real gate always sees percent 0 and never sends from this route (a
  // separate, fail-closed finding, not changed here). Wrap the REAL gate and
  // inject the percent so the send path can be exercised. Ownership is still
  // decided by the real gate.
  const realGate = require('../lib/auto-respond-gate');
  stub('../lib/auto-respond-gate', {
    ...realGate,
    evaluateAutoRespond: (args) => realGate.evaluateAutoRespond({ ...args, settings: { ...args.settings, auto_respond_percent: 100 } }),
  });
  stub('../lib/user-data', { resolveCustomerData: async () => null });
  stub('../lib/copilot', {
    generateSuggestion: async () => {
      calls.generate += 1;
      if (scenario === 'takeover_during_generation') setStatus('assigned');
      return { text: 'Funcionamos das 8h às 22h.', model: 'test-model' };
    },
  });
  // Every real export becomes a no-op, so no code path can reach Evolution.
  const noOps = Object.fromEntries(Object.keys(require('../lib/evolution-client')).map((name) => [name, async () => null]));
  stub('../lib/evolution-client', {
    ...noOps,
    sendPresence: async () => {
      calls.presence += 1;
      if (scenario === 'escalated_during_typing') setStatus('escalated');
    },
    sendText: async () => { calls.send += 1; return { key: { id: 'out-1' } }; },
  });

  ({ db } = require('../lib/db'));
  db.prepare(`INSERT INTO copilot_settings (brand_id, auto_suggest, auto_respond, auto_respond_percent, updated_at)
              VALUES ('brandx', 1, 1, 100, ?)`).run(new Date().toISOString());

  const express = require('express');
  const supertest = require('supertest');
  const app = express();
  app.use(express.json());
  app.use('/', require('../routes/ingest-evolution'));
  // Surface a route failure instead of an opaque 500.
  app.use((err, _req, res, _next) => { console.error(`ROUTE ERROR ${err.stack}`); res.status(500).json({ error: err.message }); });

  const res = await supertest(app).post('/').send({
    event: 'messages.upsert',
    instance: 'inst',
    data: {
      key: { remoteJid: '5561999990000@s.whatsapp.net', fromMe: false, id: `3EB0${scenario}` },
      pushName: 'Maria',
      messageType: 'conversation',
      message: { conversation: 'qual o horário de funcionamento?' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  });
  if (res.status !== 201) throw new Error(`webhook answered ${res.status}: ${JSON.stringify(res.body)}`);

  // Wait for the timer chain to finish, then a margin to prove nothing sends later.
  const finished = () => (scenario === 'control' ? calls.send >= 1 : calls.generate >= 1 && (scenario !== 'escalated_during_typing' || calls.presence >= 1));
  const deadline = Date.now() + 5000;
  while (!finished() && Date.now() < deadline) await new Promise((r) => realSetTimeout(r, 25));
  await new Promise((r) => realSetTimeout(r, 400));

  const out = {
    ...calls,
    suggestions: db.prepare('SELECT COUNT(*) n FROM suggestions').get().n,
    outbound: db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'outbound'").get().n,
    status: db.prepare("SELECT status FROM conversations WHERE channel = 'whatsapp'").get().status,
  };
  console.log(`RESULT ${JSON.stringify(out)}`);
  process.exit(0);
}

if (process.argv[2] === 'child') {
  runChild(process.argv[3]).catch((err) => { console.error(err.stack || err.message); process.exit(1); });
  return;
}

// ─── Parent ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); }
}

function run(scenario) {
  const dbPath = path.join(os.tmpdir(), `sc-1to1-${scenario}-${process.pid}-${Date.now()}.sqlite`);
  try {
    const stdout = execFileSync(process.execPath, [__filename, 'child', scenario], {
      env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath, EVOLUTION_INSTANCE_MAP: 'inst:brandx', SUPPORT_API_SECRET: '' },
      encoding: 'utf8',
      timeout: 60000,
    });
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `child printed no result:\n${stdout}`);
    return JSON.parse(line.slice('RESULT '.length));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

console.log('\n🧪 routes/ingest-evolution.js — 1:1 timer vs human ownership\n');

test('control: with nobody in charge the suggestion is saved and auto-sent once', () => {
  const r = run('control');
  assert.equal(r.send, 1);
  assert.equal(r.suggestions, 1);
  assert.equal(r.outbound, 1);
  assert.equal(r.status, 'open');
});

test('a takeover while the model runs saves no suggestion and sends nothing', () => {
  const r = run('takeover_during_generation');
  assert.equal(r.generate, 1);
  assert.equal(r.send, 0);
  assert.equal(r.suggestions, 0);
  assert.equal(r.outbound, 0);
  assert.equal(r.status, 'assigned');
});

test('an escalation during the typing delay stops the send right before sendText', () => {
  const r = run('escalated_during_typing');
  assert.equal(r.presence, 1);
  assert.equal(r.send, 0);
  assert.equal(r.outbound, 0);
  assert.equal(r.status, 'escalated');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
