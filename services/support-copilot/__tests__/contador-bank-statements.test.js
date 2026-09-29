'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBankStatementClient } = require('../lib/contador-bank-statements');

test('OFX client uses only the scoped API key and preserves confirmed sender', async () => {
  const calls = [];
  const client = createBankStatementClient({
    baseUrl: 'https://example.test', apiKey: 'test-api-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ counts: { new: 1 } }) };
    },
  });
  const payload = { fileName: 'extrato.ofx', contentBase64: 'T0ZY', confirmedBy: '5511999999999' };
  assert.deepEqual(await client.importOfx(payload), { counts: { new: 1 } });
  assert.equal(calls[0].url, 'https://example.test/api/accounting/bank-statements/import');
  assert.equal(calls[0].options.headers['x-api-key'], 'test-api-key');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test('OFX client fails closed without a key and does not expose API response bodies', async () => {
  const unconfigured = createBankStatementClient({ baseUrl: 'https://example.test', apiKey: '',
    fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(unconfigured.importOfx({}), /not configured/);

  const client = createBankStatementClient({
    baseUrl: 'https://example.test', apiKey: 'test-api-key',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ memo: 'private bank memo' }) }),
  });
  await assert.rejects(client.importOfx({}), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /private bank memo/);
    return true;
  });
});
