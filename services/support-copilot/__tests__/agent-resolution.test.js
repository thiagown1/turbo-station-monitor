const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const resolutionPath = path.resolve(__dirname, '../lib/agent-resolution.js');

function withEnv(overrides, fn) {
  const original = {};
  for (const [key, value] of Object.entries(overrides)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  delete require.cache[resolutionPath];

  try {
    return fn(require(resolutionPath));
  } finally {
    delete require.cache[resolutionPath];
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('resolveSupportAgent derives tenant-specific agent when brand is resolved', () => {
  withEnv({ OPENCLAW_AGENT: undefined, GROUP_AGENT: undefined, OPENCLAW_GROUP_AGENT: undefined, BRAND_AGENT_MAP: '' }, ({ resolveSupportAgent }) => {
    assert.equal(resolveSupportAgent('zev'), 'support_zev');
  });
});

test('resolveSupportAgent uses explicit fallback only when configured', () => {
  withEnv({ OPENCLAW_AGENT: 'support_shared', GROUP_AGENT: undefined, OPENCLAW_GROUP_AGENT: undefined, BRAND_AGENT_MAP: '' }, ({ resolveSupportAgent }) => {
    assert.equal(resolveSupportAgent(undefined), 'support_shared');
  });
});

test('resolveSupportAgent fails closed when no brand or fallback is available', () => {
  withEnv({ OPENCLAW_AGENT: undefined, GROUP_AGENT: undefined, OPENCLAW_GROUP_AGENT: undefined, BRAND_AGENT_MAP: '' }, ({ resolveSupportAgent }) => {
    assert.throws(() => resolveSupportAgent(undefined), /missing brand_id and OPENCLAW_AGENT fallback/);
  });
});

test('group conversations require explicit group agent or resolved tenant binding', () => {
  withEnv({ OPENCLAW_AGENT: undefined, GROUP_AGENT: undefined, OPENCLAW_GROUP_AGENT: undefined, BRAND_AGENT_MAP: '' }, ({ resolveSupportAgent }) => {
    assert.equal(resolveSupportAgent('acme', 'whatsapp-group'), 'support_acme');
    assert.throws(
      () => resolveSupportAgent(undefined, 'whatsapp-group'),
      /configure GROUP_AGENT\/OPENCLAW_GROUP_AGENT or provide a brand_id binding/
    );
  });
});

test('group conversations prefer explicit group agent when configured', () => {
  withEnv({ OPENCLAW_AGENT: undefined, GROUP_AGENT: 'support_groups', OPENCLAW_GROUP_AGENT: undefined, BRAND_AGENT_MAP: '' }, ({ resolveSupportAgent }) => {
    assert.equal(resolveSupportAgent('acme', 'whatsapp-group'), 'support_groups');
  });
});

test('parseBrandAgentMap trims whitespace and ignores malformed pairs', () => {
  withEnv({ BRAND_AGENT_MAP: ' zev : support_zev ,invalid, plugreen:support_plugreen ' }, ({ parseBrandAgentMap }) => {
    assert.deepEqual(parseBrandAgentMap(), {
      zev: 'support_zev',
      plugreen: 'support_plugreen',
    });
  });
});
