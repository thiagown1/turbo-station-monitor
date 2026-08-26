#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { hasWsLogs } = require('../services/smart-collector');

console.log('🧪 Smart collector WS health');
assert.strictEqual(hasWsLogs({ type: 'status', data: { connected: true } }), false);
assert.strictEqual(hasWsLogs({ type: 'pong' }), false);
assert.strictEqual(hasWsLogs({ type: 'log_batch', data: { entries: [] } }), false);
assert.strictEqual(hasWsLogs({ type: 'log_entry', data: { message: 'Heartbeat' } }), true);
assert.strictEqual(hasWsLogs({ type: 'log_batch', data: { entries: [{ message: 'MeterValues' }] } }), true);
console.log('  ✅ keepalive/status frames cannot mask an OCPP log stall');
console.log('✅ Smart collector WS health tests passed');
