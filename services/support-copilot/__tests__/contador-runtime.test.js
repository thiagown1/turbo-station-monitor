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
} finally {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
