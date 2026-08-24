const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWhatsappMessageContext, hasAllowedStructuredMention } = require('../lib/whatsapp-message-context');

test('extracts mention, quote, forwarding provenance and provider timestamp', () => {
  const context = extractWhatsappMessageContext({
    extendedTextMessage: {
      text: '@Turbo Station Suporte',
      contextInfo: {
        stanzaId: 'quoted-1',
        participant: '5511999999999@s.whatsapp.net',
        mentionedJid: ['5511888888888@s.whatsapp.net'],
        isForwarded: true,
        forwardingScore: 2,
      },
    },
  }, 1787497200);
  assert.equal(context.quotedMessageId, 'quoted-1');
  assert.equal(context.isForwarded, true);
  assert.equal(context.forwardingScore, 2);
  assert.deepEqual(context.mentionedJids, ['5511888888888@s.whatsapp.net']);
  assert.equal(context.providerTimestamp, '2026-08-23T15:00:00.000Z');
  assert.equal(hasAllowedStructuredMention(context, ['5511888888888@s.whatsapp.net']), true);
});

test('does not accept a plain-text fake mention without provider metadata', () => {
  const context = extractWhatsappMessageContext({ conversation: '@Turbo Station Suporte' }, 1787497200);
  assert.equal(hasAllowedStructuredMention(context, ['bot@s.whatsapp.net']), false);
});
