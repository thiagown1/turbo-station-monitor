const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-investigator-runtime-'));
process.env.SUPPORT_COPILOT_DB_PATH = path.join(tempDir, 'support-copilot.sqlite');
process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
process.env.AGENT_EVENT_SECRET = 'test-secret';

const { db } = require('../lib/db');
const { prepareStationInvestigation, routeStationInvestigation } = require('../lib/station-investigator-runtime');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function config(overrides = {}) {
  return {
    enabled: true,
    agents: { stationSupport: true },
    stationInvestigator: {
      enabled: true,
      autoSend: false,
      killSwitch: false,
      allowedConversationIds: ['conv-pilot'],
      mentionJids: ['support-bot@s.whatsapp.net'],
      dailyLimit: 20,
      ...overrides,
    },
  };
}

function input(messageId) {
  return {
    messageId,
    conversationId: 'conv-pilot',
    brandId: 'turbo_station',
    groupJid: '120363000000000000@g.us',
    instance: 'turbostation',
    senderId: '5511999999999@s.whatsapp.net',
    receivedAt: '2026-08-23T15:02:00.000Z',
    whatsappContext: {
      providerTimestamp: '2026-08-23T15:02:00.000Z',
      quotedMessageId: null,
      quotedSenderId: null,
      mentionedJids: ['unrelated@s.whatsapp.net', 'SUPPORT-BOT@s.whatsapp.net'],
      isForwarded: false,
      forwardingScore: 0,
    },
  };
}

function context(messageId) {
  return {
    contextConfidence: 'high',
    contextFingerprint: `fingerprint-${messageId}`,
    messageRefs: [{ id: messageId }],
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('runs in shadow mode and never sends when autoSend is false', async () => {
  let requestCount = 0;
  let sendCount = 0;
  const result = await routeStationInvestigation(input('shadow-message'), {
    loadConfig: async () => config({ autoSend: false }),
    buildContext: () => context('shadow-message'),
    request: async () => {
      requestCount++;
      return jsonResponse({
        decision: 'send',
        confidence: 'high',
        stationIds: ['AR2608200012'],
        reply: 'Resposta que seria enviada.',
      });
    },
    sendText: async () => {
      sendCount++;
      return { key: { id: 'unexpected-send' } };
    },
  });

  assert.equal(requestCount, 1, 'shadow mode must still run the investigation');
  assert.equal(sendCount, 0, 'shadow mode must never call the WhatsApp sender');
  assert.equal(result.status, 'review');
  const job = db.prepare('SELECT status, response_sent_at FROM station_investigation_jobs WHERE message_id = ?').get('shadow-message');
  assert.equal(job.status, 'review');
  assert.equal(job.response_sent_at, null);
});

test('replays the persisted Lago Norte conversation through shadow investigation', async () => {
  const conversationId = 'conv-lago-replay';
  const brandId = 'turbo_station';
  const requester = '5511999999999@s.whatsapp.net';
  const participant = '5561888888888@s.whatsapp.net';
  const occurredAt = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const insert = db.prepare(`INSERT INTO messages
    (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
     provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
     sender_id, sender_name, created_at)
    VALUES (?, ?, ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (id, minutesAgo, senderId, senderName, body, extra = {}) => {
    const at = occurredAt(minutesAgo);
    insert.run(
      id, conversationId, brandId, `[${senderName}]: ${body}`, body, id, at,
      JSON.stringify(extra.mentionedJids || []), extra.forwarded ? 1 : 0,
      extra.forwarded ? 1 : 0, senderId, senderName, at,
    );
  };

  add('replay-alert-1', 120, participant, 'Yves', [
    '🏢 Lago Norte',
    'ID AR2608200012',
    'connectorId: 2',
    'status: Faulted',
    'errorCode: OtherError',
    'vendorErrorCode: 33',
    'info: ACDC Module Error',
  ].join('\n'), { forwarded: true });
  add('replay-alert-2', 115, participant, 'Yves', [
    '🏢 Lago Norte',
    'ID AR2608200012',
    'connectorId: 2',
    'status: Faulted',
    'errorCode: UnderVoltage',
    'vendorErrorCode: 31',
    'info: AC Input UnderVoltage',
  ].join('\n'), { forwarded: true });
  add('replay-claim', 110, participant, 'Yves', 'é rede do transformador da rua');
  add('replay-question', 20, requester, 'Luan', 'Confirma pra mim se o Lago Norte voltou ao normal?');
  add('replay-mention', 0, requester, 'Luan', '@Turbo Station Suporte', {
    mentionedJids: ['support-bot@s.whatsapp.net'],
  });

  let requestBody;
  let sendCount = 0;
  const result = await routeStationInvestigation({
    ...input('replay-mention'),
    conversationId,
    brandId,
    whatsappContext: {
      ...input('replay-mention').whatsappContext,
      mentionedJids: ['support-bot@s.whatsapp.net'],
    },
  }, {
    loadConfig: async () => config({
      autoSend: false,
      allowedConversationIds: [conversationId],
    }),
    request: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        decision: 'review',
        confidence: 'high',
        stationIds: ['AR2608200012'],
        reply: null,
      });
    },
    sendText: async () => {
      sendCount++;
    },
  });

  assert.equal(result.status, 'review');
  assert.equal(sendCount, 0);
  assert.equal(requestBody.mentionedJid, 'support-bot@s.whatsapp.net');
  assert.match(requestBody.context.effectiveQuestion, /Lago Norte voltou ao normal/i);
  assert.deepEqual(
    requestBody.context.incidentSignals.map((signal) => signal.info),
    ['ACDC Module Error', 'AC Input UnderVoltage'],
  );
  assert.equal(requestBody.context.participantClaims[0].verified, false);
  assert.equal(requestBody.context.participantClaims[0].provenance, 'participant_report');
  assert.deepEqual(
    requestBody.context.stationHints.filter((hint) => hint.kind === 'id'),
    [{ kind: 'id', value: 'AR2608200012' }],
  );
});

test('sends the exact allowed structured mention in the central API contract', async () => {
  let requestBody;
  let sent;
  const result = await routeStationInvestigation(input('send-message'), {
    loadConfig: async () => config({ autoSend: true }),
    buildContext: () => context('send-message'),
    request: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        decision: 'send',
        confidence: 'high',
        stationIds: ['AR2608200012'],
        reply: 'Incidente reconciliado.',
      });
    },
    sendText: async (instance, groupJid, reply) => {
      sent = { instance, groupJid, reply };
      return { key: { id: 'outbound-1' } };
    },
  });

  assert.equal(requestBody.mentionedJid, 'SUPPORT-BOT@s.whatsapp.net');
  assert.deepEqual(sent, {
    instance: 'turbostation',
    groupJid: '120363000000000000@g.us',
    reply: 'Incidente reconciliado.',
  });
  assert.equal(result.status, 'sent');
  const job = db.prepare('SELECT status, response_external_message_id, last_error FROM station_investigation_jobs WHERE message_id = ?').get('send-message');
  assert.deepEqual(job, {
    status: 'sent',
    response_external_message_id: 'outbound-1',
    last_error: null,
  });
});

test('does not investigate or send the same completed message twice', async () => {
  let requestCount = 0;
  let sendCount = 0;
  const deps = {
    loadConfig: async () => config({ autoSend: true }),
    buildContext: () => context('duplicate-message'),
    request: async () => {
      requestCount++;
      return jsonResponse({
        decision: 'send',
        confidence: 'high',
        stationIds: ['AR2608200012'],
        reply: 'Resposta idempotente.',
      });
    },
    sendText: async () => {
      sendCount++;
      return { key: { id: 'outbound-duplicate-guard' } };
    },
  };

  const first = await routeStationInvestigation(input('duplicate-message'), deps);
  const second = await routeStationInvestigation(input('duplicate-message'), deps);

  assert.equal(first.status, 'sent');
  assert.deepEqual(second, { duplicate: true, status: 'sent' });
  assert.equal(requestCount, 1);
  assert.equal(sendCount, 1);
});

test('keeps the kill switch authoritative before analysis or delivery', async () => {
  let requestCount = 0;
  let sendCount = 0;
  const result = await routeStationInvestigation(input('killed-message'), {
    loadConfig: async () => config({ autoSend: true, killSwitch: true }),
    buildContext: () => context('killed-message'),
    request: async () => {
      requestCount++;
      return jsonResponse({ decision: 'send', reply: 'não enviar' });
    },
    sendText: async () => {
      sendCount++;
    },
  });

  assert.deepEqual(result, { skipped: true, reason: 'send_disabled' });
  assert.equal(requestCount, 0);
  assert.equal(sendCount, 0);
});

test('claims an allowlisted structured mention even when a later safety gate blocks it', async () => {
  const prepared = await prepareStationInvestigation(input('claimed-kill-switch'), {
    loadConfig: async () => config({ killSwitch: true }),
    buildContext: () => {
      throw new Error('context must not be built behind the kill switch');
    },
  });

  assert.deepEqual(prepared, {
    claimed: true,
    ready: false,
    result: { skipped: true, reason: 'send_disabled' },
  });
});

test('preserves station ownership when context reconstruction fails after the structured mention gate', async () => {
  const prepared = await prepareStationInvestigation(input('claimed-context-failure'), {
    loadConfig: async () => config(),
    buildContext: () => {
      throw new Error('trigger_message_not_found');
    },
  });

  assert.deepEqual(prepared, {
    claimed: true,
    ready: false,
    result: { skipped: true, reason: 'context_failed' },
  });
});

test('does not claim a lookalike plain-text mention without provider metadata', async () => {
  const withoutMention = input('unstructured-lookalike');
  withoutMention.whatsappContext.mentionedJids = [];

  const prepared = await prepareStationInvestigation(withoutMention, {
    loadConfig: async () => config(),
  });

  assert.deepEqual(prepared, {
    claimed: false,
    ready: false,
    result: { skipped: true, reason: 'structured_mention_required' },
  });
});

test('routes Luans natural Habibs question to shadow review after an exact mention', async () => {
  const conversationId = 'conv-habibs-pilot';
  const brandId = 'turbo_station';
  const requester = '5561999999999@s.whatsapp.net';
  const insert = db.prepare(`INSERT INTO messages
    (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
     provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
     sender_id, sender_name, created_at)
    VALUES (?, ?, ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`);
  const questionAt = new Date(Date.now() - 60_000).toISOString();
  const mentionAt = new Date().toISOString();
  insert.run(
    'habibs-question', conversationId, brandId, '[Luan]: Habibs desarmou de novo?',
    'Habibs desarmou de novo?', 'habibs-question', questionAt, '[]', requester, 'Luan', questionAt,
  );
  insert.run(
    'habibs-mention', conversationId, brandId, '[Luan]: @Turbo Station Suporte',
    '@Turbo Station Suporte', 'habibs-mention', mentionAt,
    JSON.stringify(['support-bot@s.whatsapp.net']), requester, 'Luan', mentionAt,
  );

  let requestBody;
  let sendCount = 0;
  const result = await routeStationInvestigation({
    ...input('habibs-mention'),
    conversationId,
    brandId,
    receivedAt: mentionAt,
  }, {
    loadConfig: async () => config({ autoSend: false, allowedConversationIds: [conversationId] }),
    request: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        decision: 'review',
        confidence: 'medium',
        stationIds: ['DFAR2606180001'],
        candidateReply: 'Resposta candidata sobre o Habibs.',
        reply: null,
      });
    },
    sendText: async () => {
      sendCount++;
    },
  });

  assert.equal(result.status, 'review');
  assert.equal(sendCount, 0);
  assert.equal(requestBody.context.effectiveQuestion, 'Habibs desarmou de novo?');
  assert.equal(requestBody.context.contextConfidence, 'medium');
  assert.deepEqual(requestBody.context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
  assert.equal(requestBody.mentionedJid, 'SUPPORT-BOT@s.whatsapp.net');
});

test('does not build context or call the central API without a structured mention', async () => {
  let contextBuildCount = 0;
  let requestCount = 0;
  let sendCount = 0;
  const withoutMention = input('plain-text-habibs');
  withoutMention.whatsappContext.mentionedJids = [];

  const result = await routeStationInvestigation(withoutMention, {
    loadConfig: async () => config({ autoSend: false }),
    buildContext: () => {
      contextBuildCount++;
      return context('plain-text-habibs');
    },
    request: async () => {
      requestCount++;
      return jsonResponse({ decision: 'review' });
    },
    sendText: async () => {
      sendCount++;
    },
  });

  assert.deepEqual(result, { skipped: true, reason: 'structured_mention_required' });
  assert.equal(contextBuildCount, 0);
  assert.equal(requestCount, 0);
  assert.equal(sendCount, 0);
});

test('does not send when autoSend is enabled but the central decision requires review', async () => {
  let sendCount = 0;
  const result = await routeStationInvestigation(input('central-review'), {
    loadConfig: async () => config({ autoSend: true }),
    buildContext: () => context('central-review'),
    request: async () => jsonResponse({
      decision: 'review',
      confidence: 'medium',
      stationIds: ['DFAR2606180001'],
      candidateReply: 'Aguardando revisão humana.',
      reply: null,
    }),
    sendText: async () => {
      sendCount++;
    },
  });

  assert.equal(result.status, 'review');
  assert.equal(sendCount, 0);
  const job = db.prepare('SELECT status, decision, response_sent_at FROM station_investigation_jobs WHERE message_id = ?').get('central-review');
  assert.deepEqual(job, { status: 'review', decision: 'review', response_sent_at: null });
});
