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
const { routeInboundMessageDurably } = require('../lib/agent-router');
const {
  deliverDueStationInvestigations,
  prepareStationInvestigation,
  routeStationInvestigation,
} = require('../lib/station-investigator-runtime');

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

test('keeps persisted review ownership when current configuration is unavailable', async () => {
  const messageId = 'review-owned-during-config-outage';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'review', 1, ?, ?, ?)`)
    .run(messageId, 'conv-pilot', 'turbo_station', '120363000000000000@g.us', 'turbostation', now, now, now);

  let configLoads = 0;
  const prepared = await prepareStationInvestigation(input(messageId), {
    loadConfig: async () => {
      configLoads++;
      throw new Error('temporary config outage');
    },
  });

  assert.deepEqual(prepared, {
    claimed: true,
    ready: false,
    result: { duplicate: true, status: 'review' },
  });
  assert.equal(configLoads, 0, 'terminal persisted ownership must be resolved before current config');
});

test('keeps a retry job claimed when the investigator is currently disabled', async () => {
  const messageId = 'retry-owned-while-disabled';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'retry', 1, ?, ?, ?)`)
    .run(messageId, 'conv-pilot', 'turbo_station', '120363000000000000@g.us', 'turbostation', now, now, now);

  const prepared = await prepareStationInvestigation(input(messageId), {
    loadConfig: async () => config({ enabled: false }),
  });

  assert.deepEqual(prepared, {
    claimed: true,
    ready: false,
    result: { skipped: true, reason: 'disabled' },
  });
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

test('persists ownership for every safety gate reached after a valid claim', async (t) => {
  const scenarios = [
    {
      name: 'kill switch',
      id: 'owned-kill-switch',
      deps: { loadConfig: async () => config({ killSwitch: true }) },
      reason: 'send_disabled',
    },
    {
      name: 'daily limit',
      id: 'owned-daily-limit',
      deps: { loadConfig: async () => config({ dailyLimit: 0 }) },
      reason: 'daily_limit',
    },
    {
      name: 'context failure',
      id: 'owned-context-failure',
      deps: {
        loadConfig: async () => config(),
        buildContext: () => { throw new Error('context failed'); },
      },
      reason: 'context_failed',
    },
    {
      name: 'low confidence',
      id: 'owned-low-confidence',
      deps: {
        loadConfig: async () => config(),
        buildContext: () => ({ ...context('owned-low-confidence'), contextConfidence: 'low' }),
      },
      reason: 'low_context_confidence',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const prepared = await prepareStationInvestigation(input(scenario.id), scenario.deps);
      assert.equal(prepared.claimed, true);
      assert.deepEqual(prepared.result, { skipped: true, reason: scenario.reason });
      const job = db.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?').get(scenario.id);
      assert.deepEqual(job, { status: 'claimed' });
    });
  }

  const replay = await prepareStationInvestigation(input('owned-kill-switch'), {
    loadConfig: async () => config({ enabled: false }),
  });
  assert.deepEqual(replay, {
    claimed: true,
    ready: false,
    result: { skipped: true, reason: 'disabled' },
  });
});

test('persists ownership when the central service is unavailable after a valid claim', async () => {
  const originalBaseUrl = process.env.AGENT_EVENT_BASE_URL;
  delete process.env.AGENT_EVENT_BASE_URL;
  try {
    const prepared = await prepareStationInvestigation(input('owned-central-unavailable'), {
      loadConfig: async () => config(),
    });
    assert.equal(prepared.claimed, true);
    assert.deepEqual(prepared.result, { skipped: true, reason: 'central_unavailable' });
    const job = db.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?')
      .get('owned-central-unavailable');
    assert.deepEqual(job, { status: 'claimed' });
  } finally {
    process.env.AGENT_EVENT_BASE_URL = originalBaseUrl;
  }
});

test('does not charge ownership-only markers against the daily investigation limit', async () => {
  const blockedInput = { ...input('owned-without-investigation'), brandId: 'quota-test-brand' };
  const blocked = await prepareStationInvestigation(blockedInput, {
    loadConfig: async () => config({ killSwitch: true }),
  });
  assert.equal(blocked.claimed, true);

  const investigationInput = { ...input('first-real-investigation'), brandId: 'quota-test-brand' };
  const prepared = await prepareStationInvestigation(investigationInput, {
    loadConfig: async () => config({ dailyLimit: 1 }),
    buildContext: () => context('first-real-investigation'),
  });
  assert.equal(prepared.claimed, true);
  assert.equal(prepared.ready, true);
});

test('rechecks the daily limit when a rate-limited claimed message is replayed', async () => {
  const rateLimitedInput = { ...input('rate-limited-replay'), brandId: 'rate-limit-replay-brand' };
  let contextBuilds = 0;
  const deps = {
    loadConfig: async () => config({ dailyLimit: 0 }),
    buildContext: () => {
      contextBuilds++;
      return context('rate-limited-replay');
    },
  };

  const first = await prepareStationInvestigation(rateLimitedInput, deps);
  const replay = await prepareStationInvestigation(rateLimitedInput, deps);

  assert.deepEqual(first.result, { skipped: true, reason: 'daily_limit' });
  assert.deepEqual(replay.result, { skipped: true, reason: 'daily_limit' });
  assert.equal(first.claimed, true);
  assert.equal(replay.claimed, true);
  assert.equal(contextBuilds, 0);
});

test('atomically reserves the last daily slot across different concurrent messages', async () => {
  const brandId = 'concurrent-quota-brand';
  const deps = {
    loadConfig: async () => config({ dailyLimit: 1 }),
    buildContext: (_conversationId, messageId) => context(messageId),
  };

  const results = await Promise.all([
    prepareStationInvestigation({ ...input('quota-race-one'), brandId }, deps),
    prepareStationInvestigation({ ...input('quota-race-two'), brandId }, deps),
  ]);

  assert.equal(results.filter((result) => result.ready === true).length, 1);
  assert.equal(
    results.filter((result) => result.result?.reason === 'daily_limit').length,
    1,
  );
  const statuses = db.prepare('SELECT status FROM station_investigation_jobs WHERE brand_id = ? ORDER BY message_id')
    .all(brandId)
    .map((row) => row.status)
    .sort();
  assert.deepEqual(statuses, ['claimed', 'reserved']);
});

test('atomically prevents concurrent deliveries from investigating or sending twice', async () => {
  let requestCount = 0;
  let sendCount = 0;
  let releaseRequest;
  const responsePromise = new Promise((resolve) => {
    releaseRequest = () => resolve(jsonResponse({
      decision: 'send',
      confidence: 'high',
      stationIds: ['AR2608200012'],
      reply: 'Resposta concorrente única.',
    }));
  });
  const concurrentInput = { ...input('concurrent-delivery'), brandId: 'concurrent-delivery-brand' };
  const deps = {
    loadConfig: async () => config({ autoSend: true }),
    buildContext: () => context('concurrent-delivery'),
    request: async () => {
      requestCount++;
      return responsePromise;
    },
    sendText: async () => {
      sendCount++;
      return { key: { id: 'outbound-concurrent-guard' } };
    },
  };

  const firstPromise = routeStationInvestigation(concurrentInput, deps);
  const secondPromise = routeStationInvestigation(concurrentInput, deps);
  for (let attempt = 0; attempt < 20 && requestCount === 0; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(requestCount, 1);
  releaseRequest();
  const results = await Promise.all([firstPromise, secondPromise]);

  assert.equal(results.filter((result) => result.status === 'sent').length, 1);
  assert.equal(results.filter((result) => result.duplicate === true).length, 1);
  assert.equal(requestCount, 1);
  assert.equal(sendCount, 1);
});

test('reclaims an expired processing lease but leaves a live one fenced', async () => {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  const insert = db.prepare(`INSERT INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?)`);
  insert.run('stale-processing', 'conv-pilot', 'lease-brand', '120363000000000000@g.us', 'turbostation', stale, stale, stale);
  insert.run('live-processing', 'conv-pilot', 'lease-brand', '120363000000000000@g.us', 'turbostation', now, now, now);
  let requestCount = 0;
  const deps = {
    loadConfig: async () => config({ autoSend: false }),
    buildContext: (_conversationId, messageId) => context(messageId),
    request: async () => {
      requestCount++;
      return jsonResponse({ decision: 'review', confidence: 'high', stationIds: ['AR2608200012'] });
    },
  };

  const recovered = await routeStationInvestigation({ ...input('stale-processing'), brandId: 'lease-brand' }, deps);
  const fenced = await routeStationInvestigation({ ...input('live-processing'), brandId: 'lease-brand' }, deps);

  assert.equal(recovered.status, 'review');
  assert.deepEqual(fenced, { duplicate: true, status: 'processing' });
  assert.equal(requestCount, 1);
});

test('never retries automatically after WhatsApp delivery becomes ambiguous', async () => {
  const ambiguousInput = { ...input('ambiguous-send'), brandId: 'ambiguous-send-brand' };
  let requestCount = 0;
  let sendCount = 0;
  const deps = {
    loadConfig: async () => config({ autoSend: true }),
    buildContext: () => context('ambiguous-send'),
    request: async () => {
      requestCount++;
      return jsonResponse({
        decision: 'send',
        confidence: 'high',
        stationIds: ['AR2608200012'],
        reply: 'Resposta com entrega ambígua.',
      });
    },
    sendText: async () => {
      sendCount++;
      throw new Error('socket closed without delivery confirmation');
    },
  };

  const first = await routeStationInvestigation(ambiguousInput, deps);
  const replay = await routeStationInvestigation(ambiguousInput, deps);
  const job = db.prepare('SELECT status, last_error FROM station_investigation_jobs WHERE message_id = ?')
    .get('ambiguous-send');

  assert.equal(first.status, 'delivery_unknown');
  assert.deepEqual(replay, { duplicate: true, status: 'delivery_unknown' });
  assert.equal(job.status, 'delivery_unknown');
  assert.match(job.last_error, /socket closed/);
  assert.equal(requestCount, 1);
  assert.equal(sendCount, 1);
});

test('treats a successful WhatsApp response without a message id as ambiguous', async () => {
  const missingIdInput = { ...input('missing-delivery-id'), brandId: 'missing-delivery-id-brand' };
  const result = await routeStationInvestigation(missingIdInput, {
    loadConfig: async () => config({ autoSend: true }),
    buildContext: () => context('missing-delivery-id'),
    request: async () => jsonResponse({
      decision: 'send',
      confidence: 'high',
      stationIds: ['AR2608200012'],
      reply: 'Resposta sem comprovante de entrega.',
    }),
    sendText: async () => ({ accepted: true }),
  });
  const job = db.prepare('SELECT status, response_external_message_id FROM station_investigation_jobs WHERE message_id = ?')
    .get('missing-delivery-id');

  assert.equal(result.status, 'delivery_unknown');
  assert.deepEqual(job, { status: 'delivery_unknown', response_external_message_id: null });
});

test('retries a WhatsApp send that the gateway explicitly rejected', async () => {
  const rejectedInput = { ...input('rejected-send'), brandId: 'rejected-send-brand' };
  let requestCount = 0;
  let sendCount = 0;
  const deps = {
    loadConfig: async () => config({ autoSend: true }),
    buildContext: () => context('rejected-send'),
    request: async () => {
      requestCount++;
      return jsonResponse({
        decision: 'send',
        confidence: 'high',
        stationIds: ['AR2608200012'],
        reply: 'Resposta rejeitada antes da entrega.',
      });
    },
    sendText: async () => {
      sendCount++;
      if (sendCount === 1) {
        const rejected = new Error('Evolution API sendText failed: 401');
        rejected.statusCode = 401;
        throw rejected;
      }
      return { key: { id: 'wamid-rejected-retry' } };
    },
  };

  const first = await routeStationInvestigation(rejectedInput, deps);
  const retryJob = db.prepare('SELECT status, next_attempt_at, last_error FROM station_investigation_jobs WHERE message_id = ?')
    .get('rejected-send');
  const replay = await routeStationInvestigation(rejectedInput, deps);

  assert.equal(first.status, 'retry');
  assert.equal(retryJob.status, 'retry');
  assert.ok(retryJob.next_attempt_at);
  assert.match(retryJob.last_error, /401/);
  assert.equal(replay.status, 'sent');
  assert.equal(requestCount, 2);
  assert.equal(sendCount, 2);
});

test('drains a due station retry without waiting for a provider replay', async () => {
  const messageId = 'background-retry';
  const retryInput = { ...input(messageId), brandId: 'background-retry-brand' };
  db.prepare(`INSERT INTO messages
    (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
     provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
     sender_id, sender_name, created_at)
    VALUES (?, ?, ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`)
    .run(
      'background-retry-local', retryInput.conversationId, retryInput.brandId,
      '[Luan]: @Turbo Station Suporte Habibs caiu?', '@Turbo Station Suporte Habibs caiu?',
      messageId, retryInput.receivedAt, JSON.stringify(retryInput.whatsappContext.mentionedJids),
      retryInput.senderId, 'Luan', retryInput.receivedAt,
    );

  let requestCount = 0;
  const deps = {
    loadConfig: async () => config({ autoSend: false }),
    buildContext: () => context(messageId),
    request: async () => {
      requestCount++;
      if (requestCount === 1) throw new Error('central temporarily unavailable');
      return jsonResponse({ decision: 'review', confidence: 'medium', stationIds: ['DFAR2606180001'] });
    },
  };

  const first = await routeStationInvestigation(retryInput, deps);
  assert.equal(first.status, 'retry');
  db.prepare('UPDATE station_investigation_jobs SET next_attempt_at = ? WHERE message_id = ?')
    .run(new Date(0).toISOString(), messageId);

  await deliverDueStationInvestigations(deps);

  const job = db.prepare('SELECT status, attempts, last_error FROM station_investigation_jobs WHERE message_id = ?')
    .get(messageId);
  assert.equal(job.status, 'review');
  assert.equal(job.attempts, 2);
  assert.equal(job.last_error, null);
  assert.equal(requestCount, 2);
});

test('fails closed when a due station retry has lost its source message', async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, status, attempts,
     next_attempt_at, created_at, updated_at)
    VALUES (?, 'conv-pilot', 'missing-source-brand', '120363000000000000@g.us',
      'turbostation', 'retry', 1, ?, ?, ?)`)
    .run('missing-source-retry', new Date(0).toISOString(), now, now);

  await deliverDueStationInvestigations();

  const job = db.prepare('SELECT status, last_error FROM station_investigation_jobs WHERE message_id = ?')
    .get('missing-source-retry');
  assert.deepEqual(job, { status: 'failed', last_error: 'source_message_missing' });
});

test('finalizes due station jobs whose incident context can no longer be reconstructed', async () => {
  const staleAt = new Date(0).toISOString();
  const createdAt = new Date().toISOString();
  const cases = [
    { messageId: 'context-expired-retry', status: 'retry', attempts: 1 },
    { messageId: 'context-expired-reserved', status: 'reserved', attempts: 0 },
    { messageId: 'context-expired-processing', status: 'processing', attempts: 1 },
  ];
  for (const item of cases) {
    const brandId = `${item.messageId}-brand`;
    db.prepare(`INSERT INTO messages
      (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
       provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
       sender_id, sender_name, created_at)
      VALUES (?, 'conv-pilot', ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, 'Luan', ?)`)
      .run(
        `${item.messageId}-local`, brandId,
        '[Luan]: @Turbo Station Suporte Habibs caiu?', '@Turbo Station Suporte Habibs caiu?',
        item.messageId, staleAt, JSON.stringify(['support-bot@s.whatsapp.net']),
        '5511999999999@s.whatsapp.net', staleAt,
      );
    db.prepare(`INSERT INTO station_investigation_jobs
      (message_id, conversation_id, brand_id, group_jid, instance, status, attempts,
       next_attempt_at, created_at, updated_at)
      VALUES (?, 'conv-pilot', ?, '120363000000000000@g.us', 'turbostation', ?, ?, ?, ?, ?)`)
      .run(item.messageId, brandId, item.status, item.attempts, staleAt, createdAt, staleAt);
  }
  let contextAttempts = 0;

  await deliverDueStationInvestigations({
    loadConfig: async () => config(),
    buildContext: () => {
      contextAttempts++;
      throw new Error('source message outside retained context');
    },
  });
  await deliverDueStationInvestigations({
    loadConfig: async () => config(),
    buildContext: () => {
      contextAttempts++;
      throw new Error('must not be retried');
    },
  });

  for (const item of cases) {
    const job = db.prepare('SELECT status, last_error FROM station_investigation_jobs WHERE message_id = ?')
      .get(item.messageId);
    assert.deepEqual(job, { status: 'failed', last_error: 'context_failed' }, item.status);
  }
  assert.equal(contextAttempts, cases.length, 'terminal jobs must not loop through the worker again');
});

test('finalizes due station jobs with invalid reconstructed evidence', async () => {
  const staleAt = new Date(0).toISOString();
  const createdAt = new Date().toISOString();
  const cases = [
    { messageId: 'context-became-low', mentionedJids: ['support-bot@s.whatsapp.net'], reason: 'low_context_confidence' },
    { messageId: 'structured-mention-lost', mentionedJids: [], reason: 'structured_mention_required' },
  ];
  for (const item of cases) {
    const brandId = `${item.messageId}-brand`;
    db.prepare(`INSERT INTO messages
      (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
       provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
       sender_id, sender_name, created_at)
      VALUES (?, 'conv-pilot', ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, 'Luan', ?)`)
      .run(
        `${item.messageId}-local`, brandId,
        '[Luan]: @Turbo Station Suporte Habibs caiu?', '@Turbo Station Suporte Habibs caiu?',
        item.messageId, staleAt, JSON.stringify(item.mentionedJids),
        '5511999999999@s.whatsapp.net', staleAt,
      );
    db.prepare(`INSERT INTO station_investigation_jobs
      (message_id, conversation_id, brand_id, group_jid, instance, status, attempts,
       next_attempt_at, created_at, updated_at)
      VALUES (?, 'conv-pilot', ?, '120363000000000000@g.us', 'turbostation', 'retry', 1, ?, ?, ?)`)
      .run(item.messageId, brandId, staleAt, createdAt, staleAt);
  }

  await deliverDueStationInvestigations({
    loadConfig: async () => config(),
    buildContext: () => ({ contextConfidence: 'low', contextFingerprint: 'stale', messageRefs: [] }),
  });

  for (const item of cases) {
    const job = db.prepare('SELECT status, last_error FROM station_investigation_jobs WHERE message_id = ?')
      .get(item.messageId);
    assert.deepEqual(job, { status: 'failed', last_error: item.reason }, item.messageId);
  }
});

test('backs off policy-blocked jobs so a later eligible retry can run', async () => {
  const staleAt = new Date(0).toISOString();
  const createdAt = new Date().toISOString();
  const blocked = [
    { messageId: 'blocked-global-disabled', policy: { globalEnabled: false }, reason: 'disabled' },
    { messageId: 'blocked-agent-disabled', policy: { agentEnabled: false }, reason: 'disabled' },
    { messageId: 'blocked-investigator-disabled', policy: { investigatorEnabled: false }, reason: 'disabled' },
    { messageId: 'blocked-conversation', policy: { allowed: false }, reason: 'conversation_not_allowed' },
    { messageId: 'blocked-kill-switch', policy: { killSwitch: true }, reason: 'send_disabled' },
  ];
  const eligible = { messageId: 'eligible-after-policy-blockers', policy: {} };
  for (const [index, item] of [...blocked, eligible].entries()) {
    const brandId = `${item.messageId}-brand`;
    const itemCreatedAt = new Date(Date.parse(createdAt) + index * 1_000).toISOString();
    db.prepare(`INSERT INTO messages
      (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
       provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
       sender_id, sender_name, created_at)
      VALUES (?, 'conv-pilot', ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, 'Luan', ?)`)
      .run(
        `${item.messageId}-local`, brandId,
        '[Luan]: @Turbo Station Suporte Habibs caiu?', '@Turbo Station Suporte Habibs caiu?',
        item.messageId, staleAt, JSON.stringify(['support-bot@s.whatsapp.net']),
        '5511999999999@s.whatsapp.net', staleAt,
      );
    db.prepare(`INSERT INTO station_investigation_jobs
      (message_id, conversation_id, brand_id, group_jid, instance, status, attempts,
       next_attempt_at, created_at, updated_at)
      VALUES (?, 'conv-pilot', ?, '120363000000000000@g.us', 'turbostation', 'retry', 1, ?, ?, ?)`)
      .run(item.messageId, brandId, staleAt, itemCreatedAt, staleAt);
  }
  const policyByBrand = new Map([...blocked, eligible].map((item) => [`${item.messageId}-brand`, item.policy]));
  let requestCount = 0;
  const deps = {
    loadConfig: async (brandId) => {
      const policy = policyByBrand.get(brandId) || {};
      const loaded = config({
        killSwitch: policy.killSwitch === true,
        allowedConversationIds: policy.allowed === false ? ['another-conversation'] : ['conv-pilot'],
      });
      loaded.enabled = policy.globalEnabled !== false;
      loaded.agents.stationSupport = policy.agentEnabled !== false;
      loaded.stationInvestigator.enabled = policy.investigatorEnabled !== false;
      return loaded;
    },
    buildContext: (_conversationId, messageId) => context(messageId),
    request: async () => {
      requestCount++;
      return jsonResponse({ decision: 'review', confidence: 'medium', stationIds: ['DFAR2606180001'] });
    },
  };

  await deliverDueStationInvestigations(deps);
  assert.equal(requestCount, 0, 'the first batch contains only the five oldest blocked jobs');
  const afterFirstBatch = blocked.map((item) => db.prepare(
    'SELECT status, next_attempt_at, last_error FROM station_investigation_jobs WHERE message_id = ?',
  ).get(item.messageId));
  for (const [index, job] of afterFirstBatch.entries()) {
    assert.equal(job.status, 'retry');
    assert.ok(Date.parse(job.next_attempt_at) > Date.now());
    assert.equal(job.last_error, blocked[index].reason);
  }

  await deliverDueStationInvestigations(deps);
  assert.equal(requestCount, 1, 'the eligible sixth job must run on the next worker pass');
  assert.equal(db.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?')
    .get(eligible.messageId).status, 'review');
});

test('does not overwrite a concurrent station transition while finalizing stale context', async () => {
  const messageId = 'context-finalization-cas';
  const brandId = `${messageId}-brand`;
  const staleAt = new Date(0).toISOString();
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO messages
    (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
     provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
     sender_id, sender_name, created_at)
    VALUES (?, 'conv-pilot', ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, 'Luan', ?)`)
    .run(
      `${messageId}-local`, brandId,
      '[Luan]: @Turbo Station Suporte Habibs caiu?', '@Turbo Station Suporte Habibs caiu?',
      messageId, staleAt, JSON.stringify(['support-bot@s.whatsapp.net']),
      '5511999999999@s.whatsapp.net', staleAt,
    );
  db.prepare(`INSERT INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, status, attempts,
     next_attempt_at, created_at, updated_at)
    VALUES (?, 'conv-pilot', ?, '120363000000000000@g.us', 'turbostation', 'retry', 1, ?, ?, ?)`)
    .run(messageId, brandId, staleAt, createdAt, staleAt);
  let releaseConfig;
  let announceConfigLoad;
  const configLoadStarted = new Promise((resolve) => { announceConfigLoad = resolve; });
  const configRelease = new Promise((resolve) => { releaseConfig = resolve; });

  const draining = deliverDueStationInvestigations({
    loadConfig: async () => {
      announceConfigLoad();
      await configRelease;
      return config();
    },
    buildContext: () => { throw new Error('stale context'); },
  });
  await configLoadStarted;
  db.prepare("UPDATE station_investigation_jobs SET status='sent', updated_at=? WHERE message_id=?")
    .run(new Date().toISOString(), messageId);
  releaseConfig();
  await draining;

  const job = db.prepare('SELECT status, last_error FROM station_investigation_jobs WHERE message_id = ?')
    .get(messageId);
  assert.deepEqual(job, { status: 'sent', last_error: null });
});

test('caps station retry attempts and keeps the terminal failure owned', async () => {
  const messageId = 'retry-exhausted';
  const exhaustedInput = { ...input(messageId), brandId: 'retry-exhausted-brand' };
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO station_investigation_jobs
    (message_id, conversation_id, brand_id, group_jid, instance, status, attempts,
     next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'retry', 4, ?, ?, ?)`)
    .run(
      messageId, exhaustedInput.conversationId, exhaustedInput.brandId,
      exhaustedInput.groupJid, exhaustedInput.instance, new Date(0).toISOString(), now, now,
    );
  let requestCount = 0;
  const deps = {
    loadConfig: async () => config(),
    buildContext: () => context(messageId),
    request: async () => {
      requestCount++;
      throw new Error('central still unavailable');
    },
  };

  const lastAttempt = await routeStationInvestigation(exhaustedInput, deps);
  const replay = await routeStationInvestigation(exhaustedInput, deps);
  const job = db.prepare('SELECT status, attempts, last_error FROM station_investigation_jobs WHERE message_id = ?')
    .get(messageId);

  assert.equal(lastAttempt.status, 'failed');
  assert.deepEqual(replay, { duplicate: true, status: 'failed' });
  assert.deepEqual(job, { status: 'failed', attempts: 5, last_error: 'central still unavailable' });
  assert.equal(requestCount, 1);
});

test('keeps a durable generic media job from being claimed after config recovery', async () => {
  const externalId = 'generic-owned-external';
  const localId = 'generic-owned-local';
  const genericInput = { ...input(externalId), brandId: 'generic-owned-brand' };
  db.prepare(`INSERT INTO messages
    (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
     provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
     sender_id, sender_name, created_at)
    VALUES (?, ?, ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`)
    .run(
      localId, genericInput.conversationId, genericInput.brandId,
      '[Luan]: @Turbo Station Suporte Habibs caiu?', '@Turbo Station Suporte Habibs caiu?',
      externalId, genericInput.receivedAt, JSON.stringify(genericInput.whatsappContext.mentionedJids),
      genericInput.senderId, 'Luan', genericInput.receivedAt,
    );
  db.prepare(`INSERT INTO agent_media_jobs
    (message_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, '{}', 'retry', 1, ?, ?, ?)`)
    .run(localId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

  let configLoads = 0;
  const prepared = await prepareStationInvestigation(genericInput, {
    loadConfig: async () => {
      configLoads++;
      return config();
    },
  });

  assert.deepEqual(prepared, {
    claimed: false,
    ready: false,
    result: { skipped: true, reason: 'generic_pipeline_owned' },
  });
  assert.equal(configLoads, 0, 'persisted generic ownership should win before current config');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM station_investigation_jobs WHERE message_id = ?').get(externalId).count, 0);
});

test('keeps a durable station claim from being acquired by the generic pipeline', async () => {
  const externalId = 'station-owned-external';
  const localId = 'station-owned-local';
  const stationInput = { ...input(externalId), brandId: 'station-owned-brand' };
  db.prepare(`INSERT INTO messages
    (id, conversation_id, brand_id, direction, source, body, raw_body, external_message_id,
     provider_timestamp, mentioned_jids_json, is_forwarded, forwarding_score,
     sender_id, sender_name, created_at)
    VALUES (?, ?, ?, 'inbound', 'evolution', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`)
    .run(
      localId, stationInput.conversationId, stationInput.brandId,
      '[Luan]: @Turbo Station Suporte Habibs caiu?', '@Turbo Station Suporte Habibs caiu?',
      externalId, stationInput.receivedAt, JSON.stringify(stationInput.whatsappContext.mentionedJids),
      stationInput.senderId, 'Luan', stationInput.receivedAt,
    );
  const prepared = await prepareStationInvestigation(stationInput, {
    loadConfig: async () => config({ killSwitch: true }),
  });
  assert.equal(prepared.claimed, true);

  const generic = await routeInboundMessageDurably({
    messageId: localId,
    externalMessageId: externalId,
    conversationId: stationInput.conversationId,
    brandId: stationInput.brandId,
    groupJid: stationInput.groupJid,
    instance: stationInput.instance,
    sender: 'Luan',
    senderId: stationInput.senderId,
    body: '[Luan]: @Turbo Station Suporte Habibs caiu?',
    media: { media_type: 'image', url: 'https://example.invalid/evidence.jpg' },
    receivedAt: stationInput.receivedAt,
  });

  assert.deepEqual(generic, {
    skipped: true,
    reason: 'station_pipeline_owned',
    fallbackHandled: true,
  });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM agent_media_jobs WHERE message_id = ?').get(localId).count, 0);
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
