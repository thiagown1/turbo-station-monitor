#!/usr/bin/env node
const assert = require('assert');
const { parseBrandAgentMap, resolveAgentForBrand } = require('./lib/agent-routing');

function expectThrows(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert(thrown, 'Expected function to throw');
  assert.strictEqual(thrown.code, code);
}

(function main() {
  const brandAgentMap = parseBrandAgentMap('zev:support_zev_custom');

  assert.strictEqual(resolveAgentForBrand({ brandId: 'zev', brandAgentMap }), 'support_zev_custom');
  assert.strictEqual(resolveAgentForBrand({ brandId: 'brandx' }), 'support_brandx');
  assert.strictEqual(resolveAgentForBrand({ brandId: 'brandx', channel: 'whatsapp-group' }), 'support_brandx');

  expectThrows(() => resolveAgentForBrand({}), 'COPILOT_AGENT_UNRESOLVED');
  expectThrows(() => resolveAgentForBrand({ channel: 'whatsapp-group' }), 'COPILOT_AGENT_UNRESOLVED');

  assert.strictEqual(resolveAgentForBrand({ defaultAgent: 'support_default' }), 'support_default');
  assert.strictEqual(resolveAgentForBrand({ channel: 'whatsapp-group', defaultAgent: 'support_default' }), 'support_default');

  assert.strictEqual(resolveAgentForBrand({ brandId: 'brandx', channel: 'whatsapp-group', groupAgent: 'support_groups_only' }), 'support_groups_only');

  console.log('test-agent-resolution: ok');
})();
