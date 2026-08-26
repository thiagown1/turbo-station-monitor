#!/usr/bin/env node
'use strict';

const assert = require('assert');

process.env.PAGARME_WEBHOOK_SECRET = 'test-pagarme-secret-not-real';
const { secretOk, summarize, safeText } = require('../services/pagarme-status-webhook');

console.log('🧪 Pagar.me webhook security');
assert.strictEqual(secretOk('test-pagarme-secret-not-real'), true);
assert.strictEqual(secretOk('wrong'), false);
assert.strictEqual(secretOk(''), false);
console.log('  ✅ requires the configured webhook secret');

assert.strictEqual(safeText('ok\n--danger\u0000', 20), 'ok --danger');
const message = summarize({ incident: { name: 'A\nB', status: 'investigating', body: 'x'.repeat(500) } });
assert.ok(!message.includes('\u0000'));
assert.ok(message.length < 600);
console.log('  ✅ bounds and sanitizes untrusted status text');

console.log('✅ Pagar.me webhook security tests passed');
