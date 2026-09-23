#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { shouldInjectOutboundIntoAgent } = require('../services/support-copilot/lib/agent-injection-policy');

assert.equal(shouldInjectOutboundIntoAgent('operator'), true);
assert.equal(shouldInjectOutboundIntoAgent(undefined), true);
assert.equal(shouldInjectOutboundIntoAgent('github-webhook'), false);
assert.equal(shouldInjectOutboundIntoAgent('pagarme-status-webhook'), false);

console.log('Agent injection policy tests passed');
