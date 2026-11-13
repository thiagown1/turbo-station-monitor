#!/usr/bin/env node
/**
 * Regression: the GitHub webhook must not call the OpenClaw gateway
 * (`/hooks/agent` on port 18789). The gateway is not running on the box, and
 * the short_trader hook path was the only caller.
 *
 * Static check: the webhook source no longer references the gateway.
 *
 * Run: node --test test/test-github-webhook-no-gateway.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'services', 'github-webhook.js'), 'utf8');

const GATEWAY_MARKERS = [
  '18789',
  '/hooks/agent',
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_HOOKS_TOKEN',
  'sendOpenClawAgentRequest',
  'isLegacyOpenClawHookEnabled',
];

test('github-webhook.js has no OpenClaw gateway call', () => {
  for (const marker of GATEWAY_MARKERS) {
    assert.equal(SOURCE.includes(marker), false, `unexpected gateway reference: ${marker}`);
  }
});
