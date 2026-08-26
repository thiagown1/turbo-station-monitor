#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const serviceRoot = path.join(__dirname, '..');

function runIsolated(source, dbPath) {
  return execFileSync(process.execPath, ['-e', source], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: dbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://dashboard.test',
      CONTADOR_NEXT_SECRET: 'test-secret',
      AGENT_EVENT_BASE_URL: 'http://dashboard.test',
      AGENT_EVENT_SECRET: 'test-secret',
    },
    encoding: 'utf8',
  });
}

function cleanupDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

test('Contador retains model-outage jobs without spending their failure budget or fanning out', () => {
  const dbPath = path.join(os.tmpdir(), `contador-model-wait-${process.pid}-${Date.now()}.sqlite`);
  try {
    const firstOutput = runIsolated(`
      (async () => {
        const runtime = require('./lib/contador-runtime');
        const { db, nowIso } = require('./lib/db');
        let calls = 0;
        runtime._setContadorForTest({ handle: async () => {
          calls += 1;
          const error = new Error('provider weekly limit');
          error.modelUnavailable = true;
          throw error;
        } });
        const insert = db.prepare(\`INSERT INTO contador_jobs
          (id, message_id, conversation_id, brand_id, group_jid, instance, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, 'conv', 'turbo_station', 'contas@g.us', 'turbostation', 'query', '{}', 'pending', ?, ?, ?, ?)\`);
        const created = nowIso();
        const secondCreated = new Date(Date.parse(created) + 1000).toISOString();
        insert.run('job-oldest', 'message-oldest', 4, created, created, created);
        insert.run('job-second', 'message-second', 0, secondCreated, secondCreated, secondCreated);
        await runtime.processPendingJobs();
        const rows = db.prepare('SELECT id, status, attempts, model_waits, next_attempt_at FROM contador_jobs ORDER BY id').all();
        process.stdout.write(JSON.stringify({ calls, rows }));
        db.close();
      })().catch(error => { console.error(error); process.exit(1); });
    `, dbPath);
    const first = JSON.parse(firstOutput.slice(firstOutput.lastIndexOf('\n') + 1));
    assert.equal(first.calls, 1);
    assert.deepEqual(first.rows.map((row) => ({ id: row.id, status: row.status, attempts: row.attempts, model_waits: row.model_waits })), [
      { id: 'job-oldest', status: 'waiting_model', attempts: 4, model_waits: 1 },
      { id: 'job-second', status: 'pending', attempts: 0, model_waits: 0 },
    ]);
    assert.ok(Date.parse(first.rows[0].next_attempt_at) > Date.now());

    const recoveryOutput = runIsolated(`
      (async () => {
        const runtime = require('./lib/contador-runtime');
        const { db, nowIso } = require('./lib/db');
        let calls = 0;
        runtime._setContadorForTest({ handle: async () => { calls += 1; return { status: 'silent' }; } });
        db.prepare("UPDATE contador_jobs SET next_attempt_at = ? WHERE status = 'waiting_model'").run(nowIso());
        await runtime.processPendingJobs();
        const rows = db.prepare('SELECT id, status, attempts, model_waits FROM contador_jobs ORDER BY id').all();
        process.stdout.write(JSON.stringify({ calls, rows }));
        db.close();
      })().catch(error => { console.error(error); process.exit(1); });
    `, dbPath);
    const recovery = JSON.parse(recoveryOutput.slice(recoveryOutput.lastIndexOf('\n') + 1));
    assert.equal(recovery.calls, 2);
    assert.deepEqual(recovery.rows, [
      { id: 'job-oldest', status: 'completed', attempts: 5, model_waits: 1 },
      { id: 'job-second', status: 'completed', attempts: 1, model_waits: 0 },
    ]);
  } finally {
    cleanupDb(dbPath);
  }
});

test('media analysis retains environmental model failures and resumes from the durable payload', () => {
  const dbPath = path.join(os.tmpdir(), `media-model-wait-${process.pid}-${Date.now()}.sqlite`);
  try {
    const firstOutput = runIsolated(`
      (async () => {
        let calls = 0;
        require.cache[require.resolve('./lib/agent-media-classifier')] = { exports: {
          classifyMessage: async () => { calls += 1; return { status: 'error', reason: 'http_429', environmental: true }; },
        } };
        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) return { ok: true, json: async () => ({ config: {
            enabled: true, model: 'openai/gpt-4o-mini', accountingGroupConversationIds: ['conv'],
            agents: { accounting: true },
          } }) };
          throw new Error('unexpected URL ' + url);
        };
        const router = require('./lib/agent-router');
        const { db, nowIso } = require('./lib/db');
        const makeInput = (messageId) => ({
          messageId, externalMessageId: 'wa-' + messageId, conversationId: 'conv', brandId: 'turbo_station',
          groupJid: 'contas@g.us', instance: 'turbostation', senderId: 'sender', body: '[imagem]',
          media: { media_type: 'image', url: '/api/support/media/' + messageId + '.jpg' }, receivedAt: nowIso(),
        });
        try { await router.routeInboundMessageDurably(makeInput('media-oldest')); } catch (_) {}
        const queued = await router.routeInboundMessageDurably(makeInput('media-second'));
        const rows = db.prepare('SELECT message_id, status, attempts, model_waits FROM agent_media_jobs ORDER BY message_id').all();
        process.stdout.write(JSON.stringify({ calls, queued, rows }));
        db.close();
      })().catch(error => { console.error(error); process.exit(1); });
    `, dbPath);
    const first = JSON.parse(firstOutput.slice(firstOutput.lastIndexOf('\n') + 1));
    assert.equal(first.calls, 1);
    assert.equal(first.queued.waitingForModel, true);
    assert.deepEqual(first.rows, [
      { message_id: 'media-oldest', status: 'waiting_model', attempts: 0, model_waits: 1 },
      { message_id: 'media-second', status: 'pending', attempts: 0, model_waits: 0 },
    ]);

    const recoveryOutput = runIsolated(`
      (async () => {
        let calls = 0;
        require.cache[require.resolve('./lib/agent-media-classifier')] = { exports: {
          classifyMessage: async () => {
            calls += 1;
            return { status: 'ok', kind: 'expense_receipt', amountCents: 15000, summary: 'Pagamento', confidence: 0.99, needsAttention: true };
          },
        } };
        global.fetch = async (url) => {
          if (String(url).includes('/api/agents/config')) return { ok: true, json: async () => ({ config: {
            enabled: true, model: 'openai/gpt-4o-mini', accountingGroupConversationIds: ['conv'],
            agents: { accounting: true },
          } }) };
          if (String(url).includes('/api/agents/events')) return { ok: true, status: 202, text: async () => '{}' };
          throw new Error('unexpected URL ' + url);
        };
        const router = require('./lib/agent-router');
        const { db, nowIso } = require('./lib/db');
        db.prepare("UPDATE agent_media_jobs SET next_attempt_at = ? WHERE status = 'waiting_model'").run(nowIso());
        await router.deliverDueMediaJobs();
        await new Promise((resolve) => setImmediate(resolve));
        const rows = db.prepare('SELECT message_id, status, attempts, model_waits FROM agent_media_jobs ORDER BY message_id').all();
        process.stdout.write(JSON.stringify({ calls, rows }));
        db.close();
      })().catch(error => { console.error(error); process.exit(1); });
    `, dbPath);
    const recovery = JSON.parse(recoveryOutput.slice(recoveryOutput.lastIndexOf('\n') + 1));
    assert.equal(recovery.calls, 2);
    assert.deepEqual(recovery.rows, [
      { message_id: 'media-oldest', status: 'completed', attempts: 1, model_waits: 1 },
      { message_id: 'media-second', status: 'completed', attempts: 1, model_waits: 0 },
    ]);
  } finally {
    cleanupDb(dbPath);
  }
});
