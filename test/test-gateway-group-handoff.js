'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { configuredIgnoredGroups, ignoredGroupJids, shouldForwardInbound } = require('../services/whatsapp-gateway/group-handoff-policy');

test('configured group is not forwarded while other chats remain active', () => {
  const ignored = ignoredGroupJids(' 120363111@g.us,120363222@g.us ');
  assert.equal(shouldForwardInbound('120363111@g.us', ignored), false);
  assert.equal(shouldForwardInbound('120363222@g.us', ignored), false);
  assert.equal(shouldForwardInbound('120363333@g.us', ignored), true);
  assert.equal(shouldForwardInbound('5511999999999@s.whatsapp.net', ignored), true);
});

test('empty configuration forwards all groups', () => {
  assert.equal(shouldForwardInbound('120363111@g.us', ignoredGroupJids('')), true);
});

test('gateway setting overrides legacy support setting; legacy remains the fallback', () => {
  const fallback = configuredIgnoredGroups({ SUPPORT_COPILOT_IGNORED_GROUP_JIDS: '120363111@g.us' });
  assert.equal(shouldForwardInbound('120363111@g.us', fallback), false);
  const override = configuredIgnoredGroups({
    GATEWAY_IGNORED_GROUP_JIDS: '120363222@g.us',
    SUPPORT_COPILOT_IGNORED_GROUP_JIDS: '120363111@g.us',
  });
  assert.equal(shouldForwardInbound('120363111@g.us', override), true);
  assert.equal(shouldForwardInbound('120363222@g.us', override), false);
});
