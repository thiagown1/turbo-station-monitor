#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { isLegacyOpenClawHookEnabled } = require('../services/lib/legacy-openclaw-hook-policy');

assert.equal(isLegacyOpenClawHookEnabled({}), false);
assert.equal(isLegacyOpenClawHookEnabled({ SHORT_TRADER_OPENCLAW_HOOK_ENABLED: 'false' }), false);
assert.equal(isLegacyOpenClawHookEnabled({ SHORT_TRADER_OPENCLAW_HOOK_ENABLED: 'true' }), true);

console.log('Legacy OpenClaw hook policy tests passed');
