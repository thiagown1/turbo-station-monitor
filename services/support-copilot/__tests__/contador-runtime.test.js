#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dbPath = path.join(os.tmpdir(), `support-copilot-contador-runtime-${process.pid}-${Date.now()}.sqlite`);

try {
  const output = execFileSync(process.execPath, ['-e', `
    const { enqueueContadorMessage, configured } = require('./lib/contador-runtime');
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
    const jobs = db.prepare('SELECT message_id, kind, status FROM contador_jobs ORDER BY created_at').all();
    process.stdout.write(JSON.stringify({ first, replay, chatter, wrongGroup, jobs }));
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
  assert.deepEqual(result.jobs, [{ message_id: 'wamid-queue-1', kind: 'pdf', status: 'pending' }]);
  console.log('PASS Contador runtime outbox is group-scoped and idempotent');

  const monthlyOutput = execFileSync(process.execPath, ['-e', `
    (async () => {
      const runtime = require('./lib/contador-runtime');
      const { db } = require('./lib/db');
      let calls = 0;
      runtime._setContadorForTest({
        heartbeat: async () => { throw new Error('daily heartbeat must be replaced on monthly day'); },
        monthlySummary: async () => { calls++; return { status: 'sent' }; },
      });
      const now = new Date('2026-08-03T11:00:00.000Z');
      await runtime.processHeartbeat(now);
      await runtime.processMonthlySummary(now);
      await runtime.processMonthlySummary(now);
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
  console.log('PASS Contador monthly summary ledger is day-scoped and idempotent');
} finally {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
