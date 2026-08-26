#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dbPath = path.join(os.tmpdir(), `support-copilot-contador-runtime-${process.pid}-${Date.now()}.sqlite`);
const backfillDbPath = `${dbPath}-backfill`;
const baselineDbPath = `${dbPath}-baseline`;
const retryDbPath = `${dbPath}-retry`;
const sendFailureDbPath = `${dbPath}-send-failure`;
const deliveryDbPath = `${dbPath}-delivery`;
const replyDbPath = `${dbPath}-reply`;

try {
  const output = execFileSync(process.execPath, ['-e', `
    const { enqueueContadorMessage, configured, isQuotedContadorDraftReply, _recordOutboundForTest } = require('./lib/contador-runtime');
    const { db } = require('./lib/db');
    if (!configured()) throw new Error('test runtime should be configured');
    const base = {
      messageId: 'wamid-queue-1',
      conversationId: 'conv-1',
      brandId: 'turbo_station',
      groupJid: 'contas@g.us',
      instance: 'turbostation',
      direction: 'inbound',
      body: '[documento]',
      media: { media_type: 'document', mimetype: 'application/pdf', filename: 'conta.pdf', url: '/api/support/media/conta.pdf' },
    };
    const first = enqueueContadorMessage(base);
    const replay = enqueueContadorMessage(base);
    const chatter = enqueueContadorMessage({ ...base, messageId: 'wamid-chat', body: 'ok', media: null });
    const wrongGroup = enqueueContadorMessage({ ...base, messageId: 'wamid-other', groupJid: 'other@g.us' });
    const quotedDraftStationReply = isQuotedContadorDraftReply({
      ...base, media: null, body: 'é da estação Galois', replyToContador: true,
      quotedContadorDraftId: 'rcpt_open',
    });
    const untrustedQuote = isQuotedContadorDraftReply({
      ...base, groupJid: 'other@g.us', media: null, replyToContador: true,
      quotedContadorDraftId: 'rcpt_open',
    });
    _recordOutboundForTest('De qual estação é essa conta?', {
      conversationId: 'conv-1', brandId: 'turbo_station', contadorDraftId: 'rcpt_open',
    }, 'wamid-draft-prompt');
    const jobs = db.prepare('SELECT message_id, kind, status FROM contador_jobs ORDER BY created_at').all();
    const prompt = db.prepare("SELECT media_json FROM messages WHERE external_message_id = 'wamid-draft-prompt'").get();
    process.stdout.write(JSON.stringify({ first, replay, chatter, wrongGroup, quotedDraftStationReply, untrustedQuote, jobs, prompt }));
    db.close();
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: dbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
    },
    encoding: 'utf8',
  });

  const result = JSON.parse(output.slice(output.lastIndexOf('\n') + 1));
  assert.equal(result.first.kind, 'pdf');
  assert.equal(result.first.enqueued, true);
  assert.equal(result.replay.enqueued, false);
  assert.equal(result.chatter.kind, 'ignored');
  assert.equal(result.wrongGroup.reason, 'group_not_allowed');
  assert.equal(result.quotedDraftStationReply, true);
  assert.equal(result.untrustedQuote, false);
  assert.deepEqual(result.jobs, [{ message_id: 'wamid-queue-1', kind: 'pdf', status: 'pending' }]);
  assert.equal(JSON.parse(result.prompt.media_json).contador.draftId, 'rcpt_open');
  console.log('PASS Contador runtime outbox is group-scoped and idempotent');

  const monthlyOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      const runtime = require('./lib/contador-runtime');
      const { db } = require('./lib/db');
      let calls = 0;
      runtime._setContadorForTest({
        heartbeat: async () => { throw new Error('daily heartbeat must be replaced on monthly day'); },
        monthlySummary: async (_runDate, hooks) => {
          calls++;
          await hooks.beforeSend();
          return { status: 'sent' };
        },
      });
      const beforeSchedule = new Date('2026-08-03T10:59:00.000Z');
      const afterMissedWindow = new Date('2026-08-04T11:00:00.000Z');
      await runtime.processMonthlySummary(beforeSchedule);
      await runtime.processMonthlySummary(afterMissedWindow);
      await runtime.processMonthlySummary(afterMissedWindow);
      const rows = db.prepare('SELECT run_month, status, attempts FROM contador_monthly_runs').all();
      process.stdout.write(JSON.stringify({ calls, rows }));
      db.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: dbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
      CONTADOR_HEARTBEAT_HOUR: '8',
      CONTADOR_MONTHLY_DAY: '3',
    },
    encoding: 'utf8',
  });
  const monthly = JSON.parse(monthlyOutput.slice(monthlyOutput.lastIndexOf('\n') + 1));
  assert.equal(monthly.calls, 1);
  assert.deepEqual(monthly.rows, [{ run_month: '2026-08', status: 'sent', attempts: 1 }]);
  console.log('PASS Contador monthly summary catches up after the schedule and stays idempotent');

  const retryOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      const runtime = require('./lib/contador-runtime');
      const { db } = require('./lib/db');
      let calls = 0;
      runtime._setContadorForTest({
        heartbeat: async () => ({ status: 'silent' }),
        monthlySummary: async () => { calls += 1; throw new Error('temporary model outage'); },
      });
      await runtime.processMonthlySummary(new Date('2026-08-03T11:00:00.000Z'));
      await runtime.processMonthlySummary(new Date('2026-08-03T11:15:00.000Z'));
      await runtime.processMonthlySummary(new Date('2026-08-03T11:30:00.000Z'));
      await runtime.processMonthlySummary(new Date('2026-08-03T11:45:00.000Z'));
      const beforeRetry = db.prepare('SELECT status, attempts, next_attempt_at FROM contador_monthly_runs WHERE run_month = ?').get('2026-08');
      await runtime.processMonthlySummary(new Date('2026-08-03T12:00:00.000Z'));
      const afterRetry = db.prepare('SELECT status, attempts, next_attempt_at FROM contador_monthly_runs WHERE run_month = ?').get('2026-08');
      process.stdout.write(JSON.stringify({ calls, beforeRetry, afterRetry }));
      db.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: retryDbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
      CONTADOR_HEARTBEAT_HOUR: '8',
      CONTADOR_MONTHLY_DAY: '3',
    },
    encoding: 'utf8',
  });
  const retry = JSON.parse(retryOutput.slice(retryOutput.lastIndexOf('\n') + 1));
  assert.equal(retry.calls, 2);
  assert.deepEqual(retry.beforeRetry, {
    status: 'failed', attempts: 1, next_attempt_at: '2026-08-03T12:00:00.000Z',
  });
  assert.deepEqual(retry.afterRetry, {
    status: 'failed', attempts: 2, next_attempt_at: '2026-08-03T16:00:00.000Z',
  });
  console.log('PASS Contador monthly retries respect persisted backoff');

  const sendFailureOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      const runtime = require('./lib/contador-runtime');
      const { db } = require('./lib/db');
      let calls = 0;
      runtime._setContadorForTest({
        heartbeat: async () => ({ status: 'silent' }),
        monthlySummary: async (_runDate, hooks) => {
          calls += 1;
          await hooks.beforeSend();
          if (calls === 1) {
            const rejected = new Error('Evolution rejected the request');
            rejected.statusCode = 401;
            throw rejected;
          }
          throw new Error('socket closed without a response');
        },
      });
      await runtime.processMonthlySummary(new Date('2026-08-03T11:00:00.000Z'));
      const rejected = db.prepare(` + "`" + `
        SELECT status, attempts, next_attempt_at, last_error
        FROM contador_monthly_runs WHERE run_month = '2026-08'
      ` + "`" + `).get();
      await runtime.processMonthlySummary(new Date('2026-08-03T11:15:00.000Z'));
      await runtime.processMonthlySummary(new Date('2026-08-03T12:00:00.000Z'));
      const ambiguous = db.prepare(` + "`" + `
        SELECT status, attempts, next_attempt_at, last_error
        FROM contador_monthly_runs WHERE run_month = '2026-08'
      ` + "`" + `).get();
      await runtime.processMonthlySummary(new Date('2026-08-03T16:00:00.000Z'));
      process.stdout.write(JSON.stringify({ calls, rejected, ambiguous }));
      db.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: sendFailureDbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
      CONTADOR_HEARTBEAT_HOUR: '8',
      CONTADOR_MONTHLY_DAY: '3',
    },
    encoding: 'utf8',
  });
  const sendFailure = JSON.parse(sendFailureOutput.slice(sendFailureOutput.lastIndexOf('\n') + 1));
  assert.deepEqual(sendFailure.rejected, {
    status: 'failed',
    attempts: 1,
    next_attempt_at: '2026-08-03T12:00:00.000Z',
    last_error: 'Evolution rejected the request',
  });
  assert.deepEqual(sendFailure.ambiguous, {
    status: 'delivery_unknown',
    attempts: 2,
    next_attempt_at: null,
    last_error: 'socket closed without a response',
  });
  assert.equal(sendFailure.calls, 2);
  console.log('PASS Contador retries definitive monthly send rejections and fences ambiguous transport failures');

  const backfillOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      const runtime = require('./lib/contador-runtime');
      const { db } = require('./lib/db');
      const calls = [];
      db.prepare(` + "`" + `
        INSERT INTO contador_monthly_runs (run_month, status, attempts, created_at, updated_at)
        VALUES ('2026-07', 'sent', 1, '2026-07-03T11:00:00.000Z', '2026-07-03T11:00:00.000Z')
      ` + "`" + `).run();
      runtime._setContadorForTest({
        heartbeat: async () => { throw new Error('daily heartbeat must not replace monthly backlog'); },
        monthlySummary: async (runDate, hooks) => {
          calls.push(runDate.toISOString().slice(0, 10));
          await hooks.beforeSend();
          return { status: 'sent' };
        },
      });
      await runtime.processMonthlySummary(new Date('2026-09-04T11:00:00.000Z'));
      const rows = db.prepare('SELECT run_month, status, attempts FROM contador_monthly_runs ORDER BY run_month').all();
      process.stdout.write(JSON.stringify({ calls, rows }));
      db.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: backfillDbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
      CONTADOR_HEARTBEAT_HOUR: '8',
      CONTADOR_MONTHLY_DAY: '3',
    },
    encoding: 'utf8',
  });
  const backfill = JSON.parse(backfillOutput.slice(backfillOutput.lastIndexOf('\n') + 1));
  assert.deepEqual(backfill.calls, ['2026-08-03', '2026-09-03']);
  assert.deepEqual(backfill.rows, [
    { run_month: '2026-07', status: 'sent', attempts: 1 },
    { run_month: '2026-08', status: 'sent', attempts: 1 },
    { run_month: '2026-09', status: 'sent', attempts: 1 },
  ]);
  console.log('PASS Contador monthly summary backfills every missed run month in order');

  const baselineOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      const runtime = require('./lib/contador-runtime');
      const { db } = require('./lib/db');
      const calls = [];
      runtime._setContadorForTest({
        heartbeat: async () => { throw new Error('daily heartbeat must not replace monthly backlog'); },
        monthlySummary: async (runDate, hooks) => {
          calls.push(runDate.toISOString().slice(0, 10));
          await hooks.beforeSend();
          return { status: 'sent' };
        },
      });
      await runtime.processMonthlySummary(new Date('2026-08-01T11:00:00.000Z'));
      await runtime.processMonthlySummary(new Date('2026-09-04T11:00:00.000Z'));
      const rows = db.prepare('SELECT run_month, status, attempts FROM contador_monthly_runs ORDER BY run_month').all();
      process.stdout.write(JSON.stringify({ calls, rows }));
      db.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: baselineDbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
      CONTADOR_HEARTBEAT_HOUR: '8',
      CONTADOR_MONTHLY_DAY: '3',
    },
    encoding: 'utf8',
  });
  const baseline = JSON.parse(baselineOutput.slice(baselineOutput.lastIndexOf('\n') + 1));
  assert.deepEqual(baseline.calls, ['2026-08-03', '2026-09-03']);
  assert.deepEqual(baseline.rows, [
    { run_month: '2026-08', status: 'sent', attempts: 1 },
    { run_month: '2026-09', status: 'sent', attempts: 1 },
  ]);
  console.log('PASS Contador monthly summary seeds an empty ledger before the first schedule');

  const deliveryOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      const runtime = require('./lib/contador-runtime');
      const { db } = require('./lib/db');
      let calls = 0;
      db.prepare(` + "`" + `
        INSERT INTO contador_monthly_runs
          (run_month, status, attempts, created_at, updated_at)
        VALUES ('2026-08', 'sending', 1, '2026-08-03T11:00:00.000Z', '2026-08-03T11:00:00.000Z')
      ` + "`" + `).run();
      runtime._setContadorForTest({
        heartbeat: async () => ({ status: 'silent' }),
        monthlySummary: async () => { calls += 1; return { status: 'sent' }; },
      });
      runtime._recoverInterruptedContadorWorkForTest('2026-08-03T11:01:00.000Z');
      await runtime.processMonthlySummary(new Date('2026-09-04T11:00:00.000Z'));
      const rows = db.prepare(` + "`" + `
        SELECT run_month, status, attempts, next_attempt_at, last_error
        FROM contador_monthly_runs ORDER BY run_month
      ` + "`" + `).all();
      process.stdout.write(JSON.stringify({ calls, rows }));
      db.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: deliveryDbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
      CONTADOR_HEARTBEAT_HOUR: '8',
      CONTADOR_MONTHLY_DAY: '3',
    },
    encoding: 'utf8',
  });
  const delivery = JSON.parse(deliveryOutput.slice(deliveryOutput.lastIndexOf('\n') + 1));
  assert.equal(delivery.calls, 0);
  assert.deepEqual(delivery.rows, [{
    run_month: '2026-08',
    status: 'delivery_unknown',
    attempts: 1,
    next_attempt_at: null,
    last_error: 'interrupted_during_send',
  }]);
  console.log('PASS Contador monthly recovery fails closed after an ambiguous send');

  const replyOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      let sends = 0;
      const evolutionPath = require.resolve('./lib/evolution-client');
      require.cache[evolutionPath] = {
        id: evolutionPath, filename: evolutionPath, loaded: true,
        exports: { sendText: async () => { sends += 1; return { key: { id: 'wamid-reply-1' } }; } },
      };
      const runtime = require('./lib/contador-runtime');
      const { db, nowIso } = require('./lib/db');
      const now = nowIso();
      db.prepare(` + "`" + `
        INSERT INTO conversations (id, brand_id, channel, customer_phone, status, created_at, updated_at)
        VALUES ('conv-reply', 'turbo_station', 'whatsapp-group', 'contas@g.us', 'open', ?, ?)
      ` + "`" + `).run(now, now);
      runtime.enqueueContadorMessage({
        messageId: 'invoice-reply-1', conversationId: 'conv-reply', brandId: 'turbo_station',
        groupJid: 'contas@g.us', instance: 'turbostation', direction: 'inbound',
        body: '[documento]', media: { media_type: 'document', mimetype: 'application/pdf' },
      });
      const job = db.prepare('SELECT id FROM contador_jobs WHERE message_id = ?').get('invoice-reply-1');
      db.prepare("UPDATE contador_jobs SET status = 'processing' WHERE id = ?").run(job.id);
      const event = {
        contadorJobId: job.id, conversationId: 'conv-reply', brandId: 'turbo_station',
        groupJid: 'contas@g.us', instance: 'turbostation',
      };
      await runtime.sendReply('Conta registrada.', event);
      await runtime.sendReply('Conta registrada.', event);
      const sent = db.prepare(` + "`" + `
        SELECT reply_status, reply_external_message_id FROM contador_jobs WHERE id = ?
      ` + "`" + `).get(job.id);
      const outboundCount = db.prepare("SELECT COUNT(*) count FROM messages WHERE source = 'contador'").get().count;

      db.prepare(` + "`" + `
        INSERT INTO contador_jobs
          (id, message_id, conversation_id, brand_id, group_jid, instance, kind, payload_json,
           status, attempts, reply_status, created_at, updated_at)
        VALUES ('job-ambiguous', 'invoice-reply-2', 'conv-reply', 'turbo_station', 'contas@g.us',
                'turbostation', 'pdf', '{}', 'processing', 1, 'sending', ?, ?)
      ` + "`" + `).run(now, now);
      runtime._recoverInterruptedContadorWorkForTest('2026-08-03T11:01:00.000Z');
      const ambiguous = db.prepare(` + "`" + `
        SELECT status, reply_status, next_attempt_at, last_error FROM contador_jobs WHERE id = 'job-ambiguous'
      ` + "`" + `).get();

      let replayedHandleCalls = 0;
      runtime._setContadorForTest({ handle: async () => { replayedHandleCalls += 1; return { status: 'sent' }; } });
      await runtime.processPendingJobs();
      const recoveredSent = db.prepare('SELECT status, reply_status FROM contador_jobs WHERE id = ?').get(job.id);
      process.stdout.write(JSON.stringify({ sends, sent, outboundCount, ambiguous, replayedHandleCalls, recoveredSent }));
      db.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUPPORT_COPILOT_DB_PATH: replyDbPath,
      CONTADOR_ENABLED: 'true',
      CONTADOR_GROUP_CONVERSATION_ID: 'contas@g.us',
      CONTADOR_NEXT_BASE_URL: 'http://localhost:9999',
      CONTADOR_NEXT_SECRET: 'test-secret',
    },
    encoding: 'utf8',
  });
  const reply = JSON.parse(replyOutput.slice(replyOutput.lastIndexOf('\n') + 1));
  assert.equal(reply.sends, 1);
  assert.deepEqual(reply.sent, { reply_status: 'sent', reply_external_message_id: 'wamid-reply-1' });
  assert.equal(reply.outboundCount, 1);
  assert.deepEqual(reply.ambiguous, {
    status: 'delivery_unknown', reply_status: 'delivery_unknown', next_attempt_at: null,
    last_error: 'interrupted_during_reply_send',
  });
  assert.equal(reply.replayedHandleCalls, 0);
  assert.deepEqual(reply.recoveredSent, { status: 'completed', reply_status: 'sent' });
  console.log('PASS Contador reply delivery is checkpointed and recovery never duplicates an ambiguous send');
} finally {
  for (const target of [dbPath, backfillDbPath, baselineDbPath, retryDbPath, sendFailureDbPath, deliveryDbPath, replyDbPath]) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  }
}
