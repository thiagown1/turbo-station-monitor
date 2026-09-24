#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { sendOperationalWhatsApp } = require('../services/lib/operational-whatsapp');

(async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return { ok: true, status: 200, json: async () => ({ id: 'msg-test' }) };
  };
  const config = {
    OPERATIONAL_WHATSAPP_CONVERSATION_ID: 'conv-test',
    MONITOR_API_SECRET: 'test-secret',
  };

  assert.deepEqual(await sendOperationalWhatsApp('test', 'github-webhook', {
    env: config, fetchImpl,
  }), { status: 'skipped_disabled' });
  assert.equal(calls.length, 0);

  assert.deepEqual(await sendOperationalWhatsApp('test', 'github-webhook', {
    env: { ...config, OPERATIONAL_WHATSAPP_ENABLED: 'true', MONITOR_API_SECRET: '' },
    fetchImpl,
  }), { status: 'skipped_unconfigured' });
  assert.equal(calls.length, 0);

  const sent = await sendOperationalWhatsApp('test', 'github-webhook', {
    env: { ...config, OPERATIONAL_WHATSAPP_ENABLED: 'true' }, fetchImpl,
  });
  assert.deepEqual(sent, { status: 'accepted', messageId: 'msg-test' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0][0]).pathname, '/api/support/conversations/conv-test/messages');
  assert.equal(calls[0][1].headers['x-api-secret'], 'test-secret');
  assert.deepEqual(JSON.parse(calls[0][1].body), { body: 'test', source: 'github-webhook' });

  const failed = await sendOperationalWhatsApp('test', 'pagarme-status-webhook', {
    env: { ...config, OPERATIONAL_WHATSAPP_ENABLED: 'true' },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(failed, { status: 'failed', reason: 'http_503' });

  const invalid = await sendOperationalWhatsApp('test', 'github-webhook', {
    env: { ...config, OPERATIONAL_WHATSAPP_ENABLED: 'true', SUPPORT_COPILOT_URL: 'invalid-url' },
    fetchImpl,
  });
  assert.deepEqual(invalid, { status: 'failed', reason: 'unreachable_or_invalid_config' });

  console.log('Operational WhatsApp relay tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
