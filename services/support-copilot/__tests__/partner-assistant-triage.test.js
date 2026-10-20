'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-triage-'));
process.env.SUPPORT_COPILOT_DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.AGENT_EVENT_BASE_URL = 'https://central.test';
process.env.PARTNER_AGENT_SECRET = 'test-partner-secret';
const { db } = require('../lib/db');
const { claimPartnerAssistantMessage } = require('../lib/partner-assistant-runtime');
const { schedulePartnerTriage } = require('../lib/partner-assistant-triage');

test.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
const config = (mode = 'shadow') => ({
  enabled: true, agents: { partnerAssistant: true },
  partnerAssistant: { triageMode: mode, autoSend: true, allowedConversationIds: ['conv_test'], mentionJids: ['bot@lid'] },
});
let seq = 0;
const input = (overrides = {}) => ({
  messageId: `triage-${++seq}`, conversationId: 'conv_test', brandId: 'test', direction: 'inbound',
  groupJid: 'test@g.us', instance: 'test', body: 'Como funciona? meu cpf 123.456.789-09',
  whatsappContext: { mentionedJids: [] }, ...overrides,
});
const output = (overrides = {}) => ({
  ok: true, mode: 'shadow', decision: 'answer', act: false,
  intent: 'how_it_works', confidence: 0.9, reason: 'intent:how_it_works', ...overrides,
});
const response = (body = output()) => ({ ok: true, status: 200, json: async () => body });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('shadow defers HTTP, dedupes concurrent replays durably, logs only safe metadata and never creates reply jobs', async () => {
  const message = input();
  const calls = [], logs = [];
  const deps = { request: async (...args) => { calls.push(args); return response(); }, log: row => logs.push(row) };
  assert.equal(schedulePartnerTriage(message, config(), deps), undefined);
  assert.equal(calls.length, 0, 'HTTP must not start on the ingest stack');
  schedulePartnerTriage(message, config(), deps);
  await tick();
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://central.test/api/agents/partner-triage');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer test-partner-secret');
  assert.deepEqual(JSON.parse(options.body), {
    brandId: 'test', subject: { type: 'whatsapp_group', conversationId: 'conv_test' },
    message: { messageId: message.messageId, text: 'Como funciona? meu cpf [cpf]' },
  });
  assert.deepEqual(logs, [{ brandId: 'test', conversationId: 'conv_test', messageId: message.messageId,
    decision: 'answer', intent: 'how_it_works', confidence: 0.9 }]);
  // Reloading the module must not reset the SQLite reservation (no in-memory dedupe).
  delete require.cache[require.resolve('../lib/partner-assistant-triage')];
  require('../lib/partner-assistant-triage').schedulePartnerTriage(message, config(), deps);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_assistant_jobs').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'outbound'").get().n, 0);
});

test('off, missing/unknown mode, disabled, unlisted group, outbound, missing direction/id and structured mentions skip HTTP', async () => {
  let calls = 0;
  const deps = { request: async () => { calls++; return response(); } };
  for (const mode of ['off', undefined, 'invalid']) schedulePartnerTriage(input(), config(mode === undefined ? null : mode), deps);
  schedulePartnerTriage(input(), { ...config(), enabled: false }, deps);
  schedulePartnerTriage(input(), { ...config(), agents: { partnerAssistant: false } }, deps);
  for (const overrides of [{ conversationId: 'other' }, { direction: 'outbound' }, { direction: undefined },
    { messageId: '' }, { body: ' ' }, { whatsappContext: { mentionedJids: ['bot@lid'] } },
    { whatsappContext: { mentionedJids: ['person@lid'] } }]) schedulePartnerTriage(input(overrides), config(), deps);
  await tick();
  assert.equal(calls, 0);
});

test('a message already owned by a mention is excluded even if its replay loses mention metadata', async () => {
  const message = input({ whatsappContext: { mentionedJids: ['bot@lid'] } });
  claimPartnerAssistantMessage(message, config());
  let calls = 0;
  schedulePartnerTriage({ ...message, whatsappContext: { mentionedJids: [] } }, config(), {
    request: async () => { calls++; return response(); },
  });
  await tick();
  assert.equal(calls, 0);
});

test('active is shadow even with act=true and autoSend=true: no reply job, review or group send', async () => {
  for (const decision of ['answer', 'forward']) {
    const message = input();
    const logs = [];
    schedulePartnerTriage(message, config('active'), {
      request: async () => response(output({ mode: 'active', decision, act: true })), log: row => logs.push(row),
    });
    await tick();
    assert.equal(logs[0].decision, decision);
    assert.equal(db.prepare('SELECT 1 FROM partner_assistant_jobs WHERE message_id = ?').get(message.messageId), undefined);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'outbound'").get().n, 0);
});

test('network/4xx/5xx/invalid JSON/malformed response never reject and never retry the paid attempt', async () => {
  const failures = [
    async () => { throw new Error('secret or message must never be logged'); },
    async () => ({ ok: false, status: 403 }), async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    ...[null, {}, output({ decision: 'private text' }), output({ intent: 'private text' }),
      output({ confidence: Infinity }), output({ confidence: 2 }), output({ act: 'yes' })].map(body => async () => response(body)),
  ];
  for (const fail of failures) {
    const message = input();
    let calls = 0;
    const logs = [];
    const deps = { request: async () => { calls++; return fail(); }, log: row => logs.push(row) };
    assert.doesNotThrow(() => schedulePartnerTriage(message, config(), deps));
    await tick();
    schedulePartnerTriage(message, config(), deps);
    await tick();
    assert.equal(calls, 1);
    assert.equal(logs.length, 0);
  }
});

test('8 second timeout aborts a hanging call without holding the caller', async () => {
  const message = input();
  let signal;
  const logs = [];
  const aborted = new Promise(resolve => {
    schedulePartnerTriage(message, config(), {
      request: async (_, options) => {
        signal = options.signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => { reject(signal.reason); resolve(); }, { once: true }));
      }, log: row => logs.push(row),
    });
  });
  const keepAlive = setTimeout(() => assert.fail('timeout did not abort'), 10_000);
  try {
    await tick();
    assert.equal(signal.aborted, false);
    await aborted;
    await tick();
    assert.equal(signal.aborted, true);
    assert.equal(logs.length, 0);
  } finally { clearTimeout(keepAlive); }
});
